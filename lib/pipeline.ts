import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { CancelledError, definitionHash, isMock, peekCache, promptOverheadChars, runAgent, UsageLimitError, type AgentName } from "./agents";
import { splitSections } from "./convert";
import { isAbstractTitle, numberSections, type NumberedSection } from "./numbering";
import { splitBodyAndReferences, type CitationReport } from "./citations";
import { endRun, jobFile, readOptional, registerRun, updateStep, ROOT, type StepId } from "./jobs";

// Por chamada de IA: agrupa seções pequenas e divide as muito grandes (menos chamadas = menos tokens).
const CHUNK_LIMIT = 14000; // caracteres


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

type Piece = { title: string; start: number; end: number; text: string };

function piecesOf(s: NumberedSection): Piece[] {
  const out: Piece[] = [];
  let cur: string[] = [];
  let len = 0;
  let start = 1;
  const flush = (end: number) => {
    if (cur.length) out.push({ title: s.title, start, end, text: cur.join("\n\n") });
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

type Chunk = { label: string; text: string };

/** Junta seções consecutivas até CHUNK_LIMIT. Cada seção vem sob "### SEÇÃO: ..." com parágrafos [¶n]. */
function packChunks(sections: NumberedSection[]): Chunk[] {
  const chunks: Chunk[] = [];
  let text = "";
  let labels: string[] = [];
  const push = () => {
    if (text) chunks.push({ label: labels.join(" + "), text });
    text = "";
    labels = [];
  };
  for (const p of sections.flatMap(piecesOf)) {
    const block = `### SEÇÃO: "${p.title}" (parágrafos ¶${p.start}–¶${p.end})\n\n${p.text}\n\n`;
    if (text.length + block.length > CHUNK_LIMIT && text) push();
    text += block;
    labels.push(p.title);
  }
  push();
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
// O resultado fica em leitura.json; as etapas seguintes só o exibem (custo zero).

type Row3 = [string, number, string, string, string];
type Leitura = {
  pt: Row3[]; // [seção, ¶, sev, trecho, correção]
  sc: { s: string; v: string; p: [number, string, string, string][] }[]; // por seção
  pl: [string, number, string, string, string, string][]; // [seção, ¶, risco, trecho, motivo, consulta]
  dg: [string, string][]; // [seção, síntese]
  ia: [string, number, string, string][]; // [seção, ¶, sinal, trecho]
};
const emptyLeitura = (): Leitura => ({ pt: [], sc: [], pl: [], dg: [], ia: [] });

function parseLeitura(text: string): Leitura {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("Resposta do agente sem JSON.");
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text.slice(a, b + 1));
  } catch {
    throw new Error("Resposta do agente com JSON inválido.");
  }
  const list = (x: unknown) => (Array.isArray(x) ? x : []);
  return {
    pt: list(j.pt).filter(Array.isArray) as Leitura["pt"],
    sc: list(j.sc).filter((x) => x && typeof x === "object") as Leitura["sc"],
    pl: list(j.pl).filter(Array.isArray) as Leitura["pl"],
    dg: list(j.dg).filter(Array.isArray) as Leitura["dg"],
    ia: list(j.ia).filter(Array.isArray) as Leitura["ia"],
  };
}

type Saved = { key: string; order: string[]; data: Leitura };

async function loadLeitura(id: string): Promise<Saved | null> {
  try {
    return JSON.parse(await fs.readFile(jobFile(id, "leitura.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Devolve a leitura já feita; só chama a IA se ainda não existir (ou se o texto/agente mudou). */
async function getLeitura(ctx: Ctx): Promise<Saved> {
  const sections = await getSections(ctx.id);
  const order = sections.map((s) => s.title);
  const chunks = packChunks(sections);
  const key = createHash("sha1")
    .update(chunks.map((c) => c.text).join("\0"))
    .update(await definitionHash("revisor-texto"))
    .update(isMock() ? "MOCK" : "REAL") // leitura simulada nunca vale para uma execução real
    .digest("hex");
  const saved = await loadLeitura(ctx.id);
  if (saved && saved.key === key) {
    ctx.total = 1;
    ctx.completed = 1;
    await publish(ctx, true);
    return saved; // já lido: nenhuma chamada de IA
  }
  const md = await fs.readFile(jobFile(ctx.id, "article.md"), "utf8");
  const title = /^#\s+(.+)$/m.exec(md)?.[1]?.replace(/[*_]/g, "").trim() ?? "(sem título)";
  const parts = await pool(
    ctx,
    chunks.map((c) => async () => {
      const out = await ai(ctx, "revisor-texto", `TÍTULO DO ARTIGO: ${title}\n${MARKS}\n\n${c.text}`, {
        cache: "leitura",
        validate: (o) => void parseLeitura(o),
      });
      return ctx.dry ? emptyLeitura() : parseLeitura(out);
    }),
  );
  const data = emptyLeitura();
  for (const x of parts) {
    data.pt.push(...x.pt);
    data.sc.push(...x.sc);
    data.pl.push(...x.pl);
    data.dg.push(...x.dg);
    data.ia.push(...x.ia);
  }
  const result: Saved = { key, order, data };
  if (!ctx.dry) await fs.writeFile(jobFile(ctx.id, "leitura.json"), JSON.stringify(result));
  return result;
}

// ---- apresentação (feita pelo código: sem tokens) ----
const SEV = { A: "🔴", B: "🟠", C: "🟡" } as const;
type SevKey = keyof typeof SEV;
const sevOf = (x: unknown): SevKey => (["A", "B", "C"].includes(String(x).toUpperCase()) ? (String(x).toUpperCase() as SevKey) : "C");
const VERDICT: Record<string, string> = { A: "Adequada", B: "Ajustes menores", C: "Revisão substancial", D: "Inadequada" };
const cell = (x: unknown) => String(x ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const norm = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Casa o nome de seção devolvido pelo agente com o título real do documento. */
function canon(order: string[], name: unknown): string {
  const n = norm(String(name ?? ""));
  return order.find((t) => norm(t) === n) ?? order.find((t) => n && (norm(t).includes(n) || n.includes(norm(t)))) ?? String(name ?? "(sem seção)");
}

type Row = { sec: string; par: number; sev: SevKey; tipo: "Português" | "Conteúdo"; trecho: string; txt: string };

function rowsOf(L: Leitura, order: string[]): { rows: Row[]; verdict: Map<string, string> } {
  const rows: Row[] = [];
  const verdict = new Map<string, string>();
  for (const r of L.pt) rows.push({ sec: canon(order, r[0]), par: Number(r[1]) || 0, sev: sevOf(r[2]), tipo: "Português", trecho: String(r[3] ?? ""), txt: String(r[4] ?? "") });
  for (const sc of L.sc) {
    const sec = canon(order, sc.s);
    const v = String(sc.v ?? "").toUpperCase();
    if (v && (!verdict.has(sec) || v > (verdict.get(sec) ?? ""))) verdict.set(sec, v); // pior veredito entre trechos
    for (const p of Array.isArray(sc.p) ? sc.p : [])
      rows.push({ sec, par: Number(p[0]) || 0, sev: sevOf(p[1]), tipo: "Conteúdo", trecho: String(p[2] ?? ""), txt: String(p[3] ?? "") });
  }
  return { rows, verdict };
}

const bySection = (order: string[], rows: Row[]) => {
  const secs = [...order, ...rows.map((r) => r.sec).filter((s) => !order.includes(s))];
  return [...new Set(secs)].map((sec) => ({ sec, rows: rows.filter((r) => r.sec === sec).sort((a, b) => a.par - b.par || a.sev.localeCompare(b.sev)) }));
};

function table(rows: Row[], withTipo: boolean) {
  const head = withTipo ? "| ¶ | Sev. | Tipo | Trecho (marcar em vermelho) | O que corrigir |\n|---|---|---|---|---|" : "| ¶ | Sev. | Trecho | O que corrigir |\n|---|---|---|---|";
  const body = rows.map((r) => (withTipo ? `| ${r.par || "geral"} | ${SEV[r.sev]} | ${r.tipo} | ${cell(r.trecho)} | ${cell(r.txt)} |` : `| ${r.par || "geral"} | ${SEV[r.sev]} | ${cell(r.trecho)} | ${cell(r.txt)} |`));
  return `${head}\n${body.join("\n")}`;
}

const countLine = (rows: Row[]) =>
  (["A", "B", "C"] as SevKey[]).map((k) => `${SEV[k]} ${rows.filter((r) => r.sev === k).length}`).join("  ");

function renderPortugues(saved: Saved) {
  const { rows } = rowsOf(saved.data, saved.order);
  const pt = rows.filter((r) => r.tipo === "Português");
  const L = ["# Revisão de português", "", `Achados: **${pt.length}** (${countLine(pt)})`, ""];
  for (const g of bySection(saved.order, pt)) {
    L.push(`## ${g.sec}`, "", g.rows.length ? table(g.rows, false) : "Sem correções relevantes.", "");
  }
  return L.join("\n");
}

function renderSecoes(saved: Saved) {
  const { rows, verdict } = rowsOf(saved.data, saved.order);
  const ct = rows.filter((r) => r.tipo === "Conteúdo");
  const L = ["# Análise seção a seção", ""];
  for (const g of bySection(saved.order, ct)) {
    const v = VERDICT[verdict.get(g.sec) ?? ""] ?? "—";
    L.push(`### ${g.sec} — ${v}`, "", g.rows.length ? table(g.rows, false) : "Sem problemas relevantes.", "");
  }
  return L.join("\n");
}

const RISK: Record<string, string> = { A: "alto", M: "médio", B: "baixo" };
const gq = (s: string) => encodeURIComponent(`"${s.replace(/["“”]/g, "").trim()}"`);

function plagioItems(saved: Saved) {
  const rank: Record<string, number> = { A: 0, M: 1, B: 2 };
  return saved.data.pl
    .map((r) => ({ sec: canon(saved.order, r[0]), par: Number(r[1]) || 0, risk: String(r[2] ?? "B").toUpperCase(), trecho: String(r[3] ?? ""), motivo: String(r[4] ?? ""), q: String(r[5] ?? "") }))
    .sort((a, b) => (rank[a.risk] ?? 3) - (rank[b.risk] ?? 3));
}

function renderPlagio(saved: Saved) {
  const items = plagioItems(saved);
  const L = [
    "# Trechos para checar possível plágio",
    "",
    "> ⚠️ Esta lista **não** prova plágio: a IA não consulta bases de comparação. São trechos com sinais (mudança de estilo, texto de manual, afirmações sem fonte etc.) para você **pesquisar**. Para verificação formal use Turnitin, iThenticate ou Copyleaks (ou a ferramenta da sua instituição).",
    "",
    `Trechos sinalizados: **${items.length}**`,
    "",
  ];
  items.forEach((p, i) => {
    L.push(
      `### ${i + 1}. [${RISK[p.risk] ?? p.risk}] ${p.sec}${p.par ? `, ¶${p.par}` : ""}`,
      `> ${p.trecho}`,
      "",
      `**Por que suspeito:** ${p.motivo}`,
      "",
      p.q
        ? `**Pesquisar:** [Google (frase exata)](https://www.google.com/search?q=${gq(p.q)}) · [Scholar](https://scholar.google.com/scholar?q=${gq(p.q)}) · [Google Livros](https://www.google.com/search?tbm=bks&q=${gq(p.q)})  \nFrase: \`${p.q}\``
        : "",
      "",
    );
  });
  return L.join("\n");
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
