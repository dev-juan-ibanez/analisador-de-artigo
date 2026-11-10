import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { CancelledError, definitionHash, isMock, peekCache, promptOverheadChars, runAgent, UsageLimitError, type AgentName } from "./agents";
import { splitSections } from "./convert";
import { isAbstractTitle, numberSections, type NumberedSection } from "./numbering";
import { splitBodyAndReferences, type CitationReport } from "./citations";
import {
  RISK, SEV, VERDICT, bySection, canon, cell, countLine, emptyLeitura, merge, parseLeitura, plagioItems, renderPlagio,
  renderPortugues, renderSecoes, rowsOf, table, verifyLeitura, type Leitura, type Row, type Saved,
} from "./leitura";
import { syncVault } from "./vault";
import { endRun, jobFile, readOptional, registerRun, updateStep, ROOT, type StepId } from "./jobs";

// Por chamada de IA: agrupa seções pequenas e divide as muito grandes (menos chamadas = menos tokens).
const CHUNK_LIMIT = 22000; // caracteres por chamada (as peças são guardadas uma a uma, então chamadas grandes não prejudicam o reaproveitamento)


/** Contexto de uma execução de etapa. */
type Ctx = {
  id: string;
  step: StepId;
  signal: AbortSignal;
  cacheDir: string;
  abort: (reason: string) => void;
  limitMessage?: string;
  // andamento
  total: number;
  completed: number;
  tokens: number;
  doneChars: number; // caracteres das chamadas já concluídas
  calls: number; // chamadas concluídas
  inflight: Map<number, number>; // chamada → caracteres gerados até agora
  expectedChars: number; // tamanho típico da resposta de uma chamada (da última execução)
  maxFraction: number;
  lastPublish: number;
  /** Simulação para estimar o gasto de tokens antes de rodar (não chama a IA nem grava nada). */
  dry: boolean;
  est: { tokens: number; calls: number };
};

let callSeq = 0;

/** Publica o andamento real: partes concluídas + texto já gerado nas partes em curso (no máx. 1x/0,7 s). */
async function publish(ctx: Ctx, force = false) {
  if (ctx.dry) return;
  const now = Date.now();
  if (!force && now - ctx.lastPublish < 700) return;
  ctx.lastPublish = now;
  let partial = 0;
  let chars = ctx.doneChars;
  for (const c of ctx.inflight.values()) {
    partial += Math.min(0.97, c / ctx.expectedChars);
    chars += c;
  }
  const raw = ctx.total ? (ctx.completed + partial) / ctx.total : 0;
  ctx.maxFraction = Math.max(ctx.maxFraction, Math.min(0.99, raw)); // nunca anda para trás
  await updateStep(ctx.id, ctx.step, {
    completed: ctx.completed,
    total: ctx.total,
    fraction: ctx.maxFraction,
    outChars: chars,
    tokens: ctx.tokens,
    progress: `${ctx.completed}/${ctx.total}`,
  });
}

/** Chama um agente com cancelamento, cache de retomada, andamento real e parada imediata em caso de limite de uso. */
async function ai(
  ctx: Ctx,
  agent: AgentName,
  prompt: string,
  opts: { timeoutMs?: number; rubrics?: string[]; cache?: string; validate?: (out: string) => void } = {},
) {
  const cacheDir = opts.cache ? jobFile(ctx.id, `cache/${opts.cache}`) : ctx.cacheDir;
  if (ctx.dry) {
    // Estimativa: entrada (mensagem + rubricas + agente) + saída típica; ~3,4 caracteres por token.
    if (!(await peekCache(agent, prompt, { cacheDir, rubrics: opts.rubrics }))) {
      const inChars = prompt.length + (await promptOverheadChars(agent, opts.rubrics));
      ctx.est.tokens += Math.round((inChars + ctx.expectedChars) / 3.4);
      ctx.est.calls++;
    }
    return "";
  }
  const callId = ++callSeq;
  try {
    const out = await runAgent(agent, prompt, {
      signal: ctx.signal,
      cacheDir,
      timeoutMs: opts.timeoutMs,
      rubrics: opts.rubrics,
      validate: opts.validate,
      onProgress: (c) => {
        ctx.inflight.set(callId, c);
        void publish(ctx);
      },
      onUsage: (t) => {
        ctx.tokens += t;
      },
    });
    ctx.doneChars += out.length;
    ctx.calls++;
    return out;
  } catch (e) {
    if (e instanceof UsageLimitError) {
      ctx.limitMessage = e.message;
      ctx.abort("limit"); // interrompe as outras chamadas da etapa
    }
    throw e;
  } finally {
    ctx.inflight.delete(callId);
  }
}

/** Executa tarefas em paralelo (o limite global de processos é do runAgent), reportando o andamento. */
async function pool<T>(ctx: Ctx, tasks: Array<() => Promise<T>>): Promise<T[]> {
  ctx.total = tasks.length;
  ctx.completed = 0;
  await publish(ctx, true);
  return Promise.all(
    tasks.map(async (t) => {
      const r = await t();
      ctx.completed++;
      await publish(ctx, true);
      return r;
    }),
  );
}

/** Grava o resultado da etapa (não faz nada na simulação de estimativa). */
const put = (ctx: Ctx, name: string, content: string) => (ctx.dry ? Promise.resolve() : fs.writeFile(jobFile(ctx.id, name), content));

// ---------- Agrupamento de seções em chamadas ----------

/** Peça = seção (ou parte dela) com chave pelo CONTEÚDO: se o texto não mudou, o resultado é reaproveitado. */
type Piece = { title: string; start: number; end: number; text: string; key: string };

function piecesOf(s: NumberedSection, salt: string): Piece[] {
  const out: Piece[] = [];
  let cur: string[] = [];
  let len = 0;
  let start = 1;
  const flush = (end: number) => {
    if (!cur.length) return;
    const text = cur.join("\n\n");
    const key = createHash("sha1").update(`${salt}\0${s.title}\0${start}-${end}\0${text}`).digest("hex");
    out.push({ title: s.title, start, end, text, key });
  };
  s.paras.forEach((p, i) => {
    const marked = `[¶${i + 1}] ${p}`;
    if (len + marked.length > CHUNK_LIMIT && cur.length) {
      flush(i);
      cur = [];
      len = 0;
      start = i + 1;
    }
    cur.push(marked);
    len += marked.length;
  });
  flush(s.paras.length);
  return out;
}

type Chunk = { label: string; text: string; pieces: Piece[] };

/** Junta peças consecutivas até CHUNK_LIMIT. Cada peça vem sob "### SEÇÃO: ..." com parágrafos [¶n]. */
function packChunks(pieces: Piece[]): Chunk[] {
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  for (const p of pieces) {
    const block = `### SEÇÃO: "${p.title}" (parágrafos ¶${p.start}–¶${p.end})\n\n${p.text}\n\n`;
    if (cur && cur.text.length + block.length > CHUNK_LIMIT) {
      chunks.push(cur);
      cur = null;
    }
    cur ??= { label: "", text: "", pieces: [] };
    cur.text += block;
    cur.pieces.push(p);
  }
  if (cur) chunks.push(cur);
  for (const c of chunks) c.label = [...new Set(c.pieces.map((p) => p.title))].join(" + ");
  return chunks;
}

async function getSections(id: string): Promise<NumberedSection[]> {
  const md = await fs.readFile(jobFile(id, "article.md"), "utf8");
  return numberSections(md).filter((s) => s.analyzed);
}

const MARKS = "Os parágrafos de cada seção estão marcados com [¶n].";

/** Resumo compacto do cruzamento de citações (sem a lista de links), para dar contexto aos agentes. */
async function citationSummary(id: string): Promise<string> {
  try {
    const r: CitationReport = JSON.parse(await fs.readFile(jobFile(id, "citacoes.json"), "utf8"));
    const L = [
      `Estilo: ${r.style}; citações no texto: ${r.citations.length}; referências na lista: ${r.references.length}.`,
      `Citadas e ausentes da lista (${r.citedButMissing.length}): ${r.citedButMissing.map((c) => c.raw).join("; ") || "nenhuma"}.`,
      `Na lista e nunca citadas (${r.listedButUncited.length}): ${r.listedButUncited.map((x) => `[${x.id}] ${x.raw.slice(0, 70)}`).join("; ") || "nenhuma"}.`,
    ];
    return L.join("\n");
  } catch {
    return "(cruzamento de citações indisponível)";
  }
}

const fileBlock = (name: string, text: string | null) => (text ? `<ARQUIVO nome="${name}">\n${text.trim()}\n</ARQUIVO>` : "");

// ---------- Etapas ----------

async function stepResumos(ctx: Ctx) {
  const md = await fs.readFile(jobFile(ctx.id, "article.md"), "utf8");
  const all = numberSections(md);
  const abs = all.filter((s) => isAbstractTitle(s.title) && s.paras.length);
  if (!abs.length) {
    ctx.total = 1;
    ctx.completed = 1;
    await publish(ctx, true);
    await put(
      ctx,
      "resumos.md",
      "# Resumos (PT · EN · ES)\n\n🔴 Não encontrei as seções **Resumo**, **Abstract** ou **Resumen** no texto convertido. Verifique a conversão (botão Texto numerado) ou se o artigo as possui.\n",
    );
    return;
  }
  const marked = (s: NumberedSection) =>
    `### SEÇÃO: "${s.title}"\n\n${s.paras.map((p, i) => `[¶${i + 1}] ${p}`).join("\n\n")}`;
  const pick = (re: RegExp, n: number) => {
    const s = all.find((x) => re.test(x.title));
    return s ? `#### ${s.title}\n${s.text.slice(0, n).replace(/\s+/g, " ")}` : "";
  };
  const body = [pick(/resultad/i, 1200), pick(/conclus/i, 800)].filter(Boolean).join("\n\n");
  const have = { pt: abs.some((s) => /^resumo/i.test(s.title)), en: abs.some((s) => /^abstract/i.test(s.title)), es: abs.some((s) => /^resumen/i.test(s.title)) };
  const missing = [!have.pt && "Resumo", !have.en && "Abstract", !have.es && "Resumen"].filter(Boolean);
  const [r] = await pool(ctx, [
    () => ai(ctx, "revisor-resumos", `${abs.map(marked).join("\n\n")}\n\nTRECHOS DO CORPO (para conferir se o resumo é sustentado):\n\n${body}`),
  ]);
  const note = missing.length ? `\n> ⚠️ Versão(ões) não encontrada(s): ${missing.join(", ")}.\n` : "";
  await put(ctx, "resumos.md", `# Resumos (PT · EN · ES)\n${note}\n${r}\n`);
}

// ---------- Leitura integrada: UMA leitura de cada trecho, reaproveitada por várias etapas ----------
// Português, Seções, Plágio (e as sínteses usadas por Geral/Relatório) saem da MESMA chamada por trecho.
// Cada peça (seção) é guardada pelo hash do seu conteúdo em data/store/leitura/: reenviar uma versão revisada
// do artigo só paga pelas seções que mudaram. O agregado do artigo fica em leitura.json.

const STORE_DIR = path.join(ROOT, "data", "store", "leitura");

async function readStore(key: string): Promise<Leitura | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(STORE_DIR, `${key}.json`), "utf8"));
  } catch {
    return null;
  }
}
async function writeStore(key: string, data: Leitura) {
  await fs.mkdir(STORE_DIR, { recursive: true });
  await fs.writeFile(path.join(STORE_DIR, `${key}.json`), JSON.stringify(data));
}

async function loadLeitura(id: string): Promise<Saved | null> {
  try {
    return JSON.parse(await fs.readFile(jobFile(id, "leitura.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Distribui o resultado de uma chamada (várias seções) entre as peças do trecho. */
function splitByPiece(L: Leitura, chunk: Chunk): Map<string, Leitura> {
  const titles = [...new Set(chunk.pieces.map((p) => p.title))];
  const out = new Map(chunk.pieces.map((p) => [p.key, emptyLeitura()]));
  const pick = (sec: unknown, par?: number) => {
    const t = canon(titles, sec);
    const cands = chunk.pieces.filter((p) => p.title === t);
    if (!cands.length) return chunk.pieces[0];
    return cands.length === 1 ? cands[0] : (cands.find((p) => par !== undefined && par >= p.start && par <= p.end) ?? cands[0]);
  };
  for (const r of L.pt) out.get(pick(r[0], Number(r[1])).key)!.pt.push(r);
  for (const sc of L.sc) out.get(pick(sc.s, Number(sc.p?.[0]?.[0])).key)!.sc.push(sc);
  for (const r of L.pl) out.get(pick(r[0], Number(r[1])).key)!.pl.push(r);
  for (const d of L.dg) out.get(pick(d[0]).key)!.dg.push(d);
  for (const r of L.ia) out.get(pick(r[0], Number(r[1])).key)!.ia.push(r);
  return out;
}

/** Devolve a leitura já feita; só chama a IA para as seções que ainda não foram lidas (ou que mudaram). */
async function getLeitura(ctx: Ctx): Promise<Saved> {
  const sections = await getSections(ctx.id);
  const order = sections.map((s) => s.title);
  const salt = `${await definitionHash("revisor-texto")}|${isMock() ? "MOCK" : "REAL"}`;
  const pieces = sections.flatMap((s) => piecesOf(s, salt));
  const key = createHash("sha1").update(pieces.map((p) => p.key).join("\0")).digest("hex");

  const saved = await loadLeitura(ctx.id);
  if (saved && saved.key === key) {
    ctx.total = 1;
    ctx.completed = 1;
    await publish(ctx, true);
    return saved; // já lido: nenhuma chamada de IA
  }

  const known = new Map<string, Leitura>();
  for (const p of pieces) {
    const hit = await readStore(p.key);
    if (hit) known.set(p.key, hit);
  }
  const todo = pieces.filter((p) => !known.has(p.key));
  const chunks = packChunks(todo);
  const md = await fs.readFile(jobFile(ctx.id, "article.md"), "utf8");
  const title = /^#\s+(.+)$/m.exec(md)?.[1]?.replace(/[*_]/g, "").trim() ?? "(sem título)";

  if (chunks.length) {
    await pool(
      ctx,
      chunks.map((c) => async () => {
        const out = await ai(ctx, "revisor-texto", `TÍTULO DO ARTIGO: ${title}\n${MARKS}\n\n${c.text}`, {
          cache: "leitura",
          validate: (o) => void parseLeitura(o),
        });
        if (ctx.dry) return;
        for (const [k, data] of splitByPiece(parseLeitura(out), c)) {
          known.set(k, data);
          await writeStore(k, data); // guardado por conteúdo: vale para este e para outros arquivos
        }
      }),
    );
  } else {
    ctx.total = 1;
    ctx.completed = 1;
    await publish(ctx, true);
  }

  // Agrega em ordem de documento e confere endereços/trechos (sem tokens).
  const raw = merge(pieces.map((p) => known.get(p.key) ?? emptyLeitura()));
  const { data } = verifyLeitura(raw, sections);
  const result: Saved = { key, order, data };
  if (!ctx.dry) await fs.writeFile(jobFile(ctx.id, "leitura.json"), JSON.stringify(result));
  return result;
}

async function stepPortugues(ctx: Ctx) {
  const saved = await getLeitura(ctx);
  await put(ctx, "portugues.md", renderPortugues(saved) + "\n");
}

async function stepSecoes(ctx: Ctx) {
  const saved = await getLeitura(ctx);
  await put(ctx, "secoes.md", renderSecoes(saved) + "\n");
}

function outlineMarkdown(md: string) {
  const all = splitSections(md);
  const words = (t: string) => (t.match(/\S+/g) ?? []).length;
  const total = all.reduce((n, s) => n + words(s.text), 0) || 1;
  const rows = all.map(
    (s, i) =>
      `| ${i + 1} | ${"—".repeat(Math.max(0, s.level - 1))}${s.level ? "#".repeat(s.level) : "(sem título)"} ${s.title} | ${words(s.text)} | ${Math.round((words(s.text) / total) * 100)}% |`,
  );
  return `Total: ${total} palavras, ${all.length} blocos.\n\n| # | Título (nível) | Palavras | % |\n|---|---|---|---|\n${rows.join("\n")}`;
}

async function stepEstrutura(ctx: Ctx) {
  const md = await fs.readFile(jobFile(ctx.id, "article.md"), "utf8");
  const body = splitBodyAndReferences(md).body;
  // Só o esqueleto e o começo de cada seção (~250 caracteres): o texto inteiro não é necessário para avaliar a divisão.
  const starts = splitSections(body)
    .filter((s) => s.text.trim())
    .map((s) => `### ${s.title}\n${s.text.slice(0, 250).replace(/\s+/g, " ")}…`)
    .join("\n\n");
  const [r] = await pool(ctx, [
    () => ai(ctx, "analista-estrutura", `ESQUELETO (automático):\n\n${outlineMarkdown(md)}\n\nINÍCIO DE CADA SEÇÃO:\n\n${starts}`),
  ]);
  await put(ctx, "estrutura.md", `# Estrutura do artigo\n\n## Esqueleto detectado\n\n${outlineMarkdown(md)}\n\n---\n\n${r}\n`);
}

async function stepPlagio(ctx: Ctx) {
  const saved = await getLeitura(ctx);
  await put(ctx, "plagio.md", renderPlagio(saved) + "\n");
}

/** Avaliação geral + indícios de IA a partir das sínteses da leitura integrada (o artigo NÃO é relido). */
async function stepGeral(ctx: Ctx) {
  const saved = await getLeitura(ctx);
  const { rows } = rowsOf(saved.data, saved.order);
  const digest = saved.data.dg.map((d) => `- **${canon(saved.order, d[0])}**: ${cell(d[1])}`).join("\n");
  const sinais = saved.data.ia.map((r) => `- ${canon(saved.order, r[0])} ¶${r[1]}: ${cell(r[2])} — "${cell(r[3])}"`).join("\n");
  const counts = bySection(saved.order, rows).map((g) => `- ${g.sec}: ${countLine(g.rows)}`).join("\n");
  const cit = await citationSummary(ctx.id);
  const estrutura = ((await readOptional(ctx.id, "estrutura.md")) ?? "").split("\n---\n").pop() ?? "";
  const [out] = await pool(ctx, [
    () =>
      ai(
        ctx,
        "revisor-geral",
        `CRUZAMENTO DE CITAÇÕES (automático):\n${cit}\n\nANÁLISE DE ESTRUTURA:\n${estrutura.trim()}\n\nSÍNTESE POR SEÇÃO:\n${digest || "(indisponível)"}\n\nSINAIS DE IA COLHIDOS NA LEITURA:\n${sinais || "(nenhum)"}\n\nCORREÇÕES POR SEÇÃO (contagem):\n${counts || "(indisponível)"}`,
      ),
  ]);
  const cut = out.search(/^#{1,3}\s*Ind[ií]cios de IA/im);
  const geral = (cut >= 0 ? out.slice(0, cut) : out).replace(/^#{1,3}\s*Avalia[cç][aã]o geral\s*/i, "").trim();
  const ia = cut >= 0 ? out.slice(cut).replace(/^#{1,3}\s*Ind[ií]cios de IA\s*/i, "").trim() : "(o agente não separou a seção de indícios de IA)";
  await put(ctx, "geral.md", `# Avaliação geral\n\n${geral}\n`);
  await put(ctx, "ia.md", `# Indícios de IA\n\n${ia}\n`);
}

async function citationSection(id: string): Promise<string> {
  try {
    const r: CitationReport = JSON.parse(await fs.readFile(jobFile(id, "citacoes.json"), "utf8"));
    const L = [
      `- Estilo detectado: **${r.style}** · citações no texto: **${r.citations.length}** · referências na lista: **${r.references.length}**`,
      `- Citadas no texto e **ausentes da lista**: **${r.citedButMissing.length}**${r.citedButMissing.length ? " — " + r.citedButMissing.map((c) => cell(c.raw)).join("; ") : ""}`,
      `- Na lista e **nunca citadas**: **${r.listedButUncited.length}**${r.listedButUncited.length ? " — " + r.listedButUncited.map((x) => `[${x.id}] ${cell(x.raw.slice(0, 80))}`).join("; ") : ""}`,
      "",
      "> A **existência** de cada obra deve ser conferida manualmente (aba *Citações e referências*, com links de DOI, Scholar e Crossref).",
    ];
    return L.join("\n");
  } catch {
    return "_Cruzamento de citações indisponível._";
  }
}

/**
 * Relatório final: o agente escreve só a parte narrativa (visão geral, pontos fortes, problemas gerais, IA, plano);
 * as tabelas por seção/¶, os resumos, as citações e a lista de plágio são inseridos PELO CÓDIGO a partir dos
 * dados já calculados (sem tokens e sem risco de endereços inventados).
 */
async function stepRelatorio(ctx: Ctx) {
  const saved = await loadLeitura(ctx.id);
  const { rows, verdict } = saved ? rowsOf(saved.data, saved.order) : { rows: [] as Row[], verdict: new Map<string, string>() };
  const groups = saved ? bySection(saved.order, rows) : [];
  const counts = groups.map((g) => `- ${g.sec}: ${countLine(g.rows)}`).join("\n");
  const top = rows
    .filter((r) => r.sev !== "C")
    .sort((a, b) => a.sev.localeCompare(b.sev))
    .slice(0, 25)
    .map((r) => `- ${SEV[r.sev]} ${r.sec} ¶${r.par || "geral"} (${r.tipo}): ${cell(r.txt).slice(0, 140)}`)
    .join("\n");
  const resumos = (await readOptional(ctx.id, "resumos.md")) ?? "";
  const resumoVeredito = resumos.split("\n").filter((l) => /^## |Veredito/.test(l)).join("\n");
  const estrutura = ((await readOptional(ctx.id, "estrutura.md")) ?? "").split("\n---\n").pop() ?? "";
  const geral = (await readOptional(ctx.id, "geral.md")) ?? "";
  const ia = (await readOptional(ctx.id, "ia.md")) ?? "";
  const pl = saved ? plagioItems(saved) : [];
  const plTop = pl.slice(0, 3).map((p) => `- [${RISK[p.risk] ?? p.risk}] ${p.sec} ¶${p.par}`).join("\n");
  const missing = [!saved && "leitura do texto (Português/Seções/Plágio)", !resumos && "resumos", !geral && "geral/IA", !estrutura && "estrutura"].filter(Boolean);
  const note = missing.length ? `\nETAPAS NÃO EXECUTADAS: ${missing.join(", ")}.` : "";
  const prompt = [
    `CORREÇÕES POR SEÇÃO (contagem):\n${counts || "(indisponível)"}`,
    `ACHADOS MAIS GRAVES (🔴/🟠):\n${top || "(nenhum)"}`,
    `RESUMOS (vereditos):\n${resumoVeredito || "(não executado)"}`,
    `ESTRUTURA:\n${estrutura.trim() || "(não executada)"}`,
    geral && fileBlock("geral.md", geral),
    ia && fileBlock("ia.md", ia),
    `PLÁGIO: ${pl.length} trecho(s) sinalizado(s) para pesquisa.\n${plTop}`,
    `CITAÇÕES:\n${await citationSummary(ctx.id)}${note}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  // Estimativa: etapas ainda não feitas entram com o tamanho típico do que enviariam ao relatório.
  if (ctx.dry) ctx.est.tokens += (saved ? 0 : 1200) + (geral ? 0 : 1500) + (ia ? 0 : 600) + (estrutura ? 0 : 800) + (resumos ? 0 : 300);
  const [narrative] = await pool(ctx, [() => ai(ctx, "redator-relatorio", prompt, { timeoutMs: 15 * 60 * 1000 })]);

  if (ctx.dry) return;
  const md = await fs.readFile(jobFile(ctx.id, "article.md"), "utf8");
  const title = /^#\s+(.+)$/m.exec(md)?.[1]?.replace(/[*_]/g, "").trim() ?? "artigo";

  // Seções geradas pelo código
  const sec4 = saved
    ? groups
        .map((g) => `### ${g.sec} — ${VERDICT[verdict.get(g.sec) ?? ""] ?? "—"}\n\n${g.rows.length ? table(g.rows, true) : "Sem correções nesta seção."}`)
        .join("\n\n")
    : "_A leitura do texto (etapas Português, Seções e Plágio) não foi executada._";
  const sec4Final = rows.length || !saved ? sec4 : "Nenhuma correção necessária.\n\n" + sec4;
  const sec5 = resumos ? resumos.replace(/^# .*\n+/, "").trim() : "_Etapa de resumos não executada._";
  const sec7extra = pl.length
    ? "\n\n**Trechos a pesquisar (plágio)** — detalhes e links na etapa *Trechos suspeitos*:\n" +
      pl.slice(0, 5).map((p) => `- [${RISK[p.risk] ?? p.risk}] ${p.sec}${p.par ? `, ¶${p.par}` : ""}: “${cell(p.trecho)}”`).join("\n")
    : "";

  // Monta na ordem 1..9
  const start = narrative.search(/^## \d\./m);
  const parts = new Map<number, string>();
  for (const chunk of (start >= 0 ? narrative.slice(start) : narrative).split(/^(?=## \d\.)/m)) {
    const n = /^## (\d)\./.exec(chunk)?.[1];
    if (n) parts.set(Number(n), chunk.trim());
  }
  const out: string[] = [`# Relatório de correções — ${title}`];
  for (let n = 1; n <= 9; n++) {
    if (n === 4) out.push(`## 4. Correções por seção e parágrafo\n\n${sec4Final}`);
    else if (n === 5) out.push(`## 5. Resumos (PT · EN · ES)\n\n${sec5}`);
    else if (n === 6) out.push(`## 6. Citações e referências\n\n${await citationSection(ctx.id)}`);
    else if (n === 7) out.push((parts.get(7) ?? "## 7. Indícios de IA e plágio") + sec7extra);
    else if (parts.has(n)) out.push(parts.get(n)!);
  }
  await put(ctx, "relatorio.md", out.join("\n\n") + "\n");
}

const RUNNERS: Partial<Record<StepId, (ctx: Ctx) => Promise<void>>> = {
  resumos: stepResumos,
  portugues: stepPortugues,
  estrutura: stepEstrutura,
  secoes: stepSecoes,
  plagio: stepPlagio,
  geral: stepGeral,
  relatorio: stepRelatorio,
};

const OUTPUTS: Partial<Record<StepId, string[]>> = {
  resumos: ["resumos.md"],
  portugues: ["portugues.md"],
  estrutura: ["estrutura.md"],
  secoes: ["secoes.md"],
  plagio: ["plagio.md"],
  geral: ["geral.md", "ia.md"],
  relatorio: ["relatorio.md"],
};

// Tamanho típico (em caracteres) da resposta de uma chamada, por etapa — base do percentual real.
// Aprende com a última execução real (a simulação não registra).
const TIMINGS = path.join(ROOT, "data", "timings.json");
const DEFAULT_CHARS: Partial<Record<StepId, number>> = {
  resumos: 2800,
  portugues: 7500, // chamada da leitura integrada (português + seção + plágio + síntese + IA)
  estrutura: 3000,
  geral: 5500,
  relatorio: 5000,
};
async function expectedChars(step: StepId) {
  try {
    const t = JSON.parse(await fs.readFile(TIMINGS, "utf8"));
    if (typeof t[step] === "number" && t[step] > 200) return t[step] as number;
  } catch {}
  return DEFAULT_CHARS[step] ?? 6000;
}
async function recordChars(step: StepId, avg: number) {
  if (isMock() || !avg) return;
  try {
    let t: Record<string, number> = {};
    try {
      t = JSON.parse(await fs.readFile(TIMINGS, "utf8"));
    } catch {}
    t[step] = Math.round(avg);
    await fs.mkdir(path.dirname(TIMINGS), { recursive: true });
    await fs.writeFile(TIMINGS, JSON.stringify(t));
  } catch {}
}

/**
 * Roda UMA etapa. `force` descarta o que já foi calculado (refazer do zero);
 * sem `force`, trechos já analisados são reaproveitados (retomar).
 */
export async function runStep(id: string, step: StepId, opts: { force?: boolean } = {}) {
  const fn = RUNNERS[step];
  if (!fn) throw new Error(`Etapa ${step} não é executável por IA`);

  const ctl = registerRun(id, step);
  const ctx: Ctx = {
    id,
    step,
    signal: ctl.signal,
    cacheDir: jobFile(id, `cache/${step}`),
    abort: (reason) => ctl.abort(reason),
    total: 0,
    completed: 0,
    tokens: 0,
    doneChars: 0,
    calls: 0,
    inflight: new Map(),
    expectedChars: await expectedChars(step),
    maxFraction: 0,
    lastPublish: 0,
    dry: false,
    est: { tokens: 0, calls: 0 },
  };
  const started = Date.now();
  try {
    if (opts.force) {
      await fs.rm(ctx.cacheDir, { recursive: true, force: true });
      if (step === "portugues" || step === "secoes" || step === "plagio") {
        // a leitura é compartilhada pelas três etapas: refazer do zero descarta a leitura guardada
        await fs.rm(jobFile(id, "cache/leitura"), { recursive: true, force: true });
        await fs.rm(jobFile(id, "leitura.json"), { force: true });
      }
    }
    for (const f of OUTPUTS[step] ?? []) await fs.rm(jobFile(id, f), { force: true });
    await updateStep(id, step, {
      status: "running",
      startedAt: new Date(started).toISOString(),
      finishedAt: undefined,
      error: undefined,
      kind: undefined,
      progress: undefined,
      completed: 0,
      total: undefined,
      fraction: 0,
      outChars: 0,
      tokens: 0,
      durationMs: undefined,
    });
    await fn(ctx);
    const durationMs = Date.now() - started;
    await recordChars(step, ctx.calls ? ctx.doneChars / ctx.calls : 0);
    await updateStep(id, step, {
      status: "done",
      finishedAt: new Date().toISOString(),
      progress: undefined,
      fraction: 1,
      tokens: ctx.tokens,
      durationMs,
    });
    await syncVault(id).catch(() => {}); // mapa do Obsidian (sem tokens); nunca derruba a etapa
  } catch (e) {
    const finishedAt = new Date().toISOString();
    if (ctl.signal.reason === "limit" || e instanceof UsageLimitError) {
      await updateStep(id, step, {
        status: "error",
        kind: "limit",
        error:
          (ctx.limitMessage ?? (e instanceof Error ? e.message : "")) +
          "\nO que já foi analisado ficou guardado: quando o limite voltar, use “Retomar” para continuar de onde parou.",
        finishedAt,
      });
    } else if (ctl.signal.aborted || e instanceof CancelledError) {
      await updateStep(id, step, {
        status: "cancelled",
        progress: "Cancelada. O que já foi analisado ficou guardado (use “Retomar”).",
        finishedAt,
      });
    } else {
      await updateStep(id, step, { status: "error", error: e instanceof Error ? e.message : String(e), finishedAt });
    }
  } finally {
    endRun(id, step);
  }
}

/** Estimativa (sem chamar a IA) de quantos tokens a etapa deve usar. Já desconta o que está guardado no cache. */
export async function estimateStep(id: string, step: StepId): Promise<{ tokens: number; calls: number } | null> {
  const fn = RUNNERS[step];
  if (!fn) return null;
  const ctx: Ctx = {
    id,
    step,
    signal: new AbortController().signal,
    cacheDir: jobFile(id, `cache/${step}`),
    abort: () => {},
    total: 0,
    completed: 0,
    tokens: 0,
    doneChars: 0,
    calls: 0,
    inflight: new Map(),
    expectedChars: await expectedChars(step),
    maxFraction: 0,
    lastPublish: 0,
    dry: true,
    est: { tokens: 0, calls: 0 },
  };
  try {
    await fn(ctx);
  } catch {
    return null;
  }
  return ctx.est;
}
