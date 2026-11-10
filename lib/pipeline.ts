import fs from "node:fs/promises";
import path from "node:path";
import { CancelledError, isMock, runAgent, UsageLimitError, type AgentName } from "./agents";
import { splitSections } from "./convert";
import { numberSections, type NumberedSection } from "./numbering";
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
};

let callSeq = 0;

/** Publica o andamento real: partes concluídas + texto já gerado nas partes em curso (no máx. 1x/0,7 s). */
async function publish(ctx: Ctx, force = false) {
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
async function ai(ctx: Ctx, agent: AgentName, prompt: string, opts: { timeoutMs?: number; rubrics?: string[] } = {}) {
  const callId = ++callSeq;
  try {
    const out = await runAgent(agent, prompt, {
      signal: ctx.signal,
      cacheDir: ctx.cacheDir,
      timeoutMs: opts.timeoutMs,
      rubrics: opts.rubrics,
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

/** Corpo do artigo sem a lista de referências (economiza tokens). */
async function articleBody(id: string) {
  return splitBodyAndReferences(await fs.readFile(jobFile(id, "article.md"), "utf8")).body;
}

const fileBlock = (name: string, text: string | null) => (text ? `<ARQUIVO nome="${name}">\n${text.trim()}\n</ARQUIVO>` : "");

// ---------- Etapas ----------

const LANGS = [
  { key: "pt", re: /^resumo\b/i, nome: "Resumo (português)", idioma: "português do Brasil" },
  { key: "en", re: /^abstract\b/i, nome: "Abstract (inglês)", idioma: "inglês" },
  { key: "es", re: /^resumen\b/i, nome: "Resumen (español)", idioma: "espanhol" },
] as const;

async function stepResumos(ctx: Ctx) {
  const md = await fs.readFile(jobFile(ctx.id, "article.md"), "utf8");
  const all = numberSections(md);
  const found = LANGS.map((l) => ({ ...l, sec: all.find((s) => l.re.test(s.title) && s.paras.length) }));
  if (!found.some((f) => f.sec)) {
    ctx.total = 1;
    ctx.completed = 1;
    await publish(ctx, true);
    await fs.writeFile(
      jobFile(ctx.id, "resumos.md"),
      "# Resumos (PT · EN · ES)\n\n🔴 Não encontrei as seções **Resumo**, **Abstract** ou **Resumen** no texto convertido. Verifique a conversão (botão Texto numerado) ou se o artigo as possui.\n",
    );
    return;
  }
  const marked = (s: NumberedSection) =>
    `### SEÇÃO: "${s.title}"\n\n${s.paras.map((p, i) => `[¶${i + 1}] ${p}`).join("\n\n")}`;
  const abstracts = found.filter((f) => f.sec).map((f) => marked(f.sec!)).join("\n\n");
  const pick = (re: RegExp, n: number) => {
    const s = all.find((x) => re.test(x.title));
    return s ? `#### ${s.title}\n${s.text.slice(0, n)}` : "";
  };
  const body = [pick(/introdu/i, 2000), pick(/resultad/i, 3000), pick(/conclus/i, 2000)].filter(Boolean).join("\n\n");
  const missing = found.filter((f) => !f.sec).map((f) => f.nome);

  // Uma chamada por idioma, em paralelo: mais rápido e com andamento real.
  const results = await pool(
    ctx,
    found.map((f) => async () => {
      if (!f.sec) return `## ${f.nome}\n\n🔴 Versão **não encontrada** no artigo.`;
      const extra =
        f.key === "pt"
          ? `\n\nTRECHOS DO CORPO DO ARTIGO (confira se o resumo é sustentado por eles):\n\n${body}`
          : "";
      return ai(
        ctx,
        "revisor-resumos",
        `REVISE SOMENTE a versão: ${f.nome} (${f.idioma}). Use o título de seção "## ${f.nome}".\nAs três versões do artigo (para conferir a fidelidade):\n\n${abstracts}${extra}`,
        { rubrics: f.key === "pt" ? ["05-resumo-pt-en-es.md", "02-portugues-academico.md"] : ["05-resumo-pt-en-es.md"] },
      );
    }),
  );
  const note = missing.length ? `\n> ⚠️ Versão(ões) não encontrada(s): ${missing.join(", ")}.\n` : "";
  await fs.writeFile(jobFile(ctx.id, "resumos.md"), `# Resumos (PT · EN · ES)\n${note}\n${results.join("\n\n---\n\n")}\n`);
}

async function stepPortugues(ctx: Ctx) {
  const chunks = packChunks(await getSections(ctx.id));
  const results = await pool(
    ctx,
    chunks.map((c) => async () => {
      const r = await ai(
        ctx,
        "revisor-portugues",
        `Revise o português do trecho abaixo. ${MARKS} O trecho contém uma ou mais seções (### SEÇÃO). Em cada achado informe a seção e o ¶.\n\n---\n${c.text}---`,
      );
      return `## ${c.label}\n\n${r}`;
    }),
  );
  await fs.writeFile(jobFile(ctx.id, "portugues.md"), `# Revisão de português\n\n${results.join("\n\n---\n\n")}\n`);
}

async function stepSecoes(ctx: Ctx) {
  const md = await fs.readFile(jobFile(ctx.id, "article.md"), "utf8");
  const context = md.slice(0, 3500);
  const chunks = packChunks(await getSections(ctx.id));
  const results = await pool(
    ctx,
    chunks.map((c) => async () => {
      const r = await ai(
        ctx,
        "analista-secao",
        `CONTEXTO DO ARTIGO (início do texto, para referência):\n---\n${context}\n---\n\nSEÇÕES A ANALISAR. ${MARKS} Analise CADA seção (### SEÇÃO) separadamente, com um bloco próprio por seção, e informe o ¶ em cada problema.\n---\n${c.text}---`,
      );
      return `## ${c.label}\n\n${r}`;
    }),
  );
  await fs.writeFile(jobFile(ctx.id, "secoes.md"), `# Análise seção a seção\n\n${results.join("\n\n---\n\n")}\n`);
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
  const body = await articleBody(ctx.id);
  const [r] = await pool(ctx, [
    () =>
      ai(
        ctx,
        "analista-estrutura",
        `ESQUELETO (extraído automaticamente do artigo):\n\n${outlineMarkdown(md)}\n\nTEXTO DO ARTIGO (sem a lista de referências):\n\n${body}`,
      ),
  ]);
  await fs.writeFile(
    jobFile(ctx.id, "estrutura.md"),
    `# Estrutura do artigo\n\n## Esqueleto detectado\n\n${outlineMarkdown(md)}\n\n---\n\n${r}\n`,
  );
}

type Passage = { excerpt: string; reason: string; risk: string; query: string; section?: string; paragraph?: number };

function parsePassages(text: string): { passages: Passage[]; notes: string } {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return { passages: [], notes: "" };
  try {
    const j = JSON.parse(text.slice(a, b + 1));
    return { passages: Array.isArray(j.passages) ? j.passages : [], notes: j.style_notes ?? "" };
  } catch {
    return { passages: [], notes: "(resposta do agente não pôde ser lida como JSON)" };
  }
}

async function stepPlagio(ctx: Ctx) {
  const chunks = packChunks(await getSections(ctx.id));
  const parsed = await pool(
    ctx,
    chunks.map((c) => async () => {
      const r = await ai(
        ctx,
        "cacador-plagio",
        `${MARKS} O trecho contém uma ou mais seções (### SEÇÃO). Para cada trecho suspeito informe em "section" o título da seção e em "paragraph" o número do ¶.\n\n---\n${c.text}---`,
      );
      return { label: c.label, ...parsePassages(r) };
    }),
  );
  const rank: Record<string, number> = { alto: 0, médio: 1, medio: 1, baixo: 2 };
  const all = parsed.flatMap((p) => p.passages).sort((a, b) => (rank[a.risk] ?? 3) - (rank[b.risk] ?? 3));
  const q = (s: string) => encodeURIComponent(`"${s.replace(/["“”]/g, "").trim()}"`);
  const L: string[] = [
    "# Trechos para checar possível plágio",
    "",
    "> ⚠️ Esta lista **não** prova plágio: a IA não consulta bases de comparação. São trechos com sinais (mudança de estilo, texto de manual, afirmações sem fonte etc.) para você **pesquisar**. Para verificação formal use Turnitin, iThenticate ou Copyleaks (ou a ferramenta da sua instituição).",
    "",
    `Trechos sinalizados: **${all.length}**`,
    "",
  ];
  all.forEach((p, i) => {
    L.push(
      `### ${i + 1}. [${p.risk}] ${p.section ?? ""}${p.paragraph ? `, ¶${p.paragraph}` : ""}`,
      `> ${p.excerpt}`,
      "",
      `**Por que suspeito:** ${p.reason}`,
      "",
      p.query
        ? `**Pesquisar:** [Google (frase exata)](https://www.google.com/search?q=${q(p.query)}) · [Scholar](https://scholar.google.com/scholar?q=${q(p.query)}) · [Google Livros](https://www.google.com/search?tbm=bks&q=${q(p.query)})  \nFrase: \`${p.query}\``
        : "",
      "",
    );
  });
  const notes = parsed.filter((p) => p.notes).map((p) => `- **${p.label}:** ${p.notes}`);
  if (notes.length) L.push("## Homogeneidade de estilo", "", ...notes);
  await fs.writeFile(jobFile(ctx.id, "plagio.md"), L.join("\n") + "\n");
}

async function stepGeral(ctx: Ctx) {
  const body = await articleBody(ctx.id);
  const cit = await citationSummary(ctx.id);
  const estrutura = await readOptional(ctx.id, "estrutura.md");
  const context = `CRUZAMENTO DE CITAÇÕES (automático):\n${cit}\n\n${fileBlock("estrutura.md", estrutura)}`;
  const [geral, ia] = await pool(ctx, [
    () => ai(ctx, "revisor-geral", `${context}\n\nTEXTO DO ARTIGO (sem a lista de referências):\n\n${body}`),
    () => ai(ctx, "detector-ia", `CRUZAMENTO DE CITAÇÕES (automático):\n${cit}\n\nTEXTO DO ARTIGO (sem a lista de referências):\n\n${body}`),
  ]);
  await fs.writeFile(jobFile(ctx.id, "geral.md"), `# Avaliação geral\n\n${geral}\n`);
  await fs.writeFile(jobFile(ctx.id, "ia.md"), `# Indícios de IA\n\n${ia}\n`);
}

async function stepRelatorio(ctx: Ctx) {
  const names = ["resumos.md", "portugues.md", "estrutura.md", "secoes.md", "plagio.md", "geral.md", "ia.md"];
  const blocks: string[] = [];
  // numerado.md = artigo inteiro com ¶ (sem a lista de referências, que vai no resumo de citações)
  const numerado = (await readOptional(ctx.id, "numerado.md")) ?? "";
  blocks.push(fileBlock("numerado.md", numerado.split(/\n## Referências\n/)[0]));
  blocks.push(fileBlock("citacoes (resumo automático)", await citationSummary(ctx.id)));
  const missing: string[] = [];
  for (const n of names) {
    const t = await readOptional(ctx.id, n);
    if (t) blocks.push(fileBlock(n, t));
    else missing.push(n);
  }
  const note = missing.length ? `\n\nArquivos NÃO disponíveis (etapas não executadas): ${missing.join(", ")}.` : "";
  const [report] = await pool(ctx, [
    () => ai(ctx, "redator-relatorio", `Escreva o relatório final com base nos arquivos abaixo.${note}\n\n${blocks.filter(Boolean).join("\n\n")}`, { timeoutMs: 15 * 60 * 1000 }),
  ]);
  // Remove qualquer frase solta do agente antes do título do relatório.
  const start = report.search(/^# /m);
  await fs.writeFile(jobFile(ctx.id, "relatorio.md"), (start > 0 ? report.slice(start) : report) + "\n");
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
  resumos: 3500,
  portugues: 6000,
  estrutura: 7000,
  secoes: 7000,
  plagio: 2500,
  geral: 9000,
  relatorio: 18000,
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
  };
  const started = Date.now();
  try {
    if (opts.force) await fs.rm(ctx.cacheDir, { recursive: true, force: true });
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
