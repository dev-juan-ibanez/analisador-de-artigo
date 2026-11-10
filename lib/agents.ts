import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./jobs";

const MAX_PARALLEL = Number(process.env.CLAUDE_MAX_PARALLEL ?? 3);

/** Limite de uso do Claude atingido (para tudo, sem insistir). */
export class UsageLimitError extends Error {}
/** Execução cancelada pelo usuário (ou por outra falha da mesma etapa). */
export class CancelledError extends Error {
  constructor() {
    super("Cancelado");
  }
}

// Estado compartilhado entre recarregamentos de módulo do dev server (HMR).
type Shared = { active: number; waiting: Array<() => void> };
const g = globalThis as unknown as { __analisadorSem?: Shared };
const sem: Shared = (g.__analisadorSem ??= { active: 0, waiting: [] });

function acquire(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new CancelledError());
  if (sem.active < MAX_PARALLEL) {
    sem.active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const ticket = () => {
      signal?.removeEventListener("abort", onAbort);
      sem.active++;
      resolve();
    };
    const onAbort = () => {
      const i = sem.waiting.indexOf(ticket);
      if (i >= 0) sem.waiting.splice(i, 1);
      reject(new CancelledError());
    };
    sem.waiting.push(ticket);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function release() {
  sem.active--;
  sem.waiting.shift()?.();
}

export type AgentName =
  | "revisor-texto"
  | "analista-estrutura"
  | "revisor-resumos"
  | "revisor-geral"
  | "redator-relatorio";

/** Rubricas (knowledge/) embutidas na mensagem de cada agente: evita uma volta extra de leitura de arquivo. */
const RUBRICS: Partial<Record<AgentName, string[]>> = {
  "revisor-texto": ["compact/portugues.md", "compact/estrutura.md", "compact/ia.md"],
  "analista-estrutura": ["compact/estrutura.md"],
  "revisor-resumos": ["compact/resumo.md"],
  "revisor-geral": ["compact/estrutura.md", "compact/ia.md", "compact/citacoes.md"],
};

async function withRubrics(agent: AgentName, prompt: string, override?: string[]): Promise<string> {
  const files = override ?? RUBRICS[agent] ?? [];
  if (!files.length) return prompt;
  const parts: string[] = [];
  for (const f of files) {
    try {
      const txt = await fs.readFile(path.join(ROOT, "knowledge", f), "utf8");
      parts.push(`<RUBRICA arquivo="${f}">\n${txt.trim()}\n</RUBRICA>`);
    } catch {}
  }
  return `${parts.join("\n\n")}\n\n<TAREFA>\n${prompt}\n</TAREFA>`;
}

export type RunOptions = {
  /** Rubricas (knowledge/) a embutir; padrão: as do agente. */
  rubrics?: string[];
  /** Valida a resposta antes de guardá-la no cache (lance um erro para recusá-la). */
  validate?: (out: string) => void;
  /** Caracteres de texto gerados até agora (andamento em tempo real). */
  onProgress?: (chars: number) => void;
  /** Tokens novos desta chamada (entrada + saída, sem leituras de cache). */
  onUsage?: (tokens: number) => void;
  timeoutMs?: number;
  model?: string;
  signal?: AbortSignal;
  /** Pasta onde guardar/reaproveitar o resultado (retomar sem gastar de novo). */
  cacheDir?: string;
};

const LIMIT_RE = /out of (?:extra )?usage|usage limit|rate limit|limit reached|resets? (?:at )?\d/i;

/** Modo simulação (sem gastar tokens): crie o arquivo data/MOCK (opcional: nele, o atraso por chamada em ms). */
const MOCK_FILE = path.join(ROOT, "data", "MOCK");
export const isMock = () => existsSync(MOCK_FILE);
const mockDelay = () => {
  try {
    return Number.parseInt(readFileSync(MOCK_FILE, "utf8")) || 3000;
  } catch {
    return 3000;
  }
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new CancelledError());
      },
      { once: true },
    );
  });

async function mockAgent(agent: AgentName, opts: RunOptions): Promise<string> {
  const text =
    agent === "revisor-texto"
      ? '{"pt":[["(simulação)",1,"B","exemplo","exemplo"]],"sc":[{"s":"(simulação)","v":"B","p":[[1,"C","exemplo","exemplo"]]}],"pl":[],"dg":[["(simulação)","síntese de exemplo"]],"ia":[]}'
      : agent === "redator-relatorio"
        ? "# Relatório de correções — (simulação)\n\n## 1. Visão geral do artigo\n**Veredito: Correções necessárias**\n\nTexto simulado."
        : `(simulação do agente ${agent})\n\n| ¶ | Sev. | Trecho | Problema | Sugestão |\n|---|---|---|---|---|\n| 1 | 🟡 | exemplo | exemplo | exemplo |`;
  const total = mockDelay() * (0.8 + Math.random() * 0.4);
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    await sleep(total / steps, opts.signal);
    opts.onProgress?.(Math.round(((text.length * 6) / steps) * i)); // finge ~6x o texto, só para mostrar a barra
  }
  opts.onUsage?.(1500);
  return text;
}

/** Hash das definições (agente + rubricas): se você ajustar um agente, o cache antigo deixa de valer. */
export async function definitionHash(agent: AgentName): Promise<string> {
  const h = createHash("sha1");
  try {
    h.update(await fs.readFile(path.join(ROOT, ".claude", "agents", `${agent}.md`), "utf8"));
    const dir = path.join(ROOT, "knowledge");
    for (const f of (await fs.readdir(path.join(dir, "compact"))).sort())
      h.update(await fs.readFile(path.join(dir, "compact", f), "utf8"));
  } catch {}
  return h.digest("hex");
}

// Modo enxuto: sem plugins/hooks/skills/MCP do usuário e sem ferramentas (uma única volta, ~12x menos tokens
// de base por chamada). Se falhar logo na primeira vez, cai automaticamente para o modo padrão.
const lg = globalThis as unknown as { __analisadorLean?: { ok: boolean; broken: boolean } };
const lean = (lg.__analisadorLean ??= { ok: false, broken: process.env.CLAUDE_LEAN === "0" });

async function emptyMcpConfig() {
  const f = path.join(ROOT, "data", "empty-mcp.json");
  try {
    await fs.access(f);
  } catch {
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, '{"mcpServers":{}}');
  }
  return f;
}

async function spawnAgent(agent: AgentName, prompt: string, opts: RunOptions): Promise<string> {
  const useLean = !lean.broken;
  try {
    const out = await spawnOnce(agent, prompt, opts, useLean ? await emptyMcpConfig() : null);
    if (useLean) lean.ok = true;
    return out;
  } catch (e) {
    const unexpected = !(e instanceof UsageLimitError) && !(e instanceof CancelledError);
    if (useLean && !lean.ok && unexpected) {
      lean.broken = true; // modo enxuto não funcionou neste ambiente: usa o padrão daqui em diante
      return spawnOnce(agent, prompt, opts, null);
    }
    throw e;
  }
}

function spawnOnce(agent: AgentName, prompt: string, opts: RunOptions, emptyMcp: string | null): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const args = [
      "-p",
      "--agent",
      agent,
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ];
    if (emptyMcp) {
      args.push("--tools", "", "--setting-sources", "project", "--disable-slash-commands", "--strict-mcp-config", "--mcp-config", emptyMcp, "--no-chrome");
    } else {
      args.push("--tools", "Read", "--allowedTools", "Read");
    }
    // Modelo: CLAUDE_MODEL_<AGENTE> (ex.: CLAUDE_MODEL_REVISOR_PORTUGUES=haiku) > CLAUDE_MODEL > padrão do Claude Code
    const model = opts.model ?? process.env[`CLAUDE_MODEL_${agent.toUpperCase().replace(/-/g, "_")}`] ?? process.env.CLAUDE_MODEL;
    if (model) args.push("--model", model);
    const child = spawn("claude", args, { cwd: ROOT, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let raw = ""; // toda a saída (para detectar mensagens de erro/limite)
    let err = "";
    let final = "";
    let isError = false;
    let chars = 0;
    let buf = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
      finish(() => reject(new CancelledError()));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`Tempo esgotado no agente ${agent}`)));
    }, opts.timeoutMs ?? 10 * 60 * 1000);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => {
      raw += d;
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const e = JSON.parse(line);
          if (e.type === "stream_event" && e.event?.type === "content_block_delta" && e.event.delta?.type === "text_delta") {
            chars += String(e.event.delta.text ?? "").length;
            opts.onProgress?.(chars);
          } else if (e.type === "result") {
            final = typeof e.result === "string" ? e.result : "";
            isError = !!e.is_error;
            const u = e.usage ?? {};
            opts.onUsage?.(
              (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), // leituras de cache não contam
            );
          }
        } catch {}
      }
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => finish(() => reject(new Error(`Não consegui executar o 'claude': ${e.message}`))));
    child.on("close", (code) =>
      finish(() => {
        const text = `${err}\n${final}\n${isError ? raw.slice(-1500) : ""}`;
        if (code === 0 && !isError && final.trim() && !LIMIT_RE.test(final.trim().slice(0, 200))) return resolve(final.trim());
        if (LIMIT_RE.test(text)) {
          const detail = text.trim().split("\n").find((l) => LIMIT_RE.test(l))?.trim() ?? "";
          return reject(new UsageLimitError(`Limite de uso do Claude atingido. ${detail}`.trim()));
        }
        reject(new Error(`Agente ${agent} falhou (código ${code}): ${(err || final || raw).slice(-600)}`));
      }),
    );
    child.stdin.end(prompt);
  });
}

/**
 * Executa um agente de .claude/agents/<name>.md com o Claude Code local (modo não interativo, só Read).
 * Com `cacheDir`, resultados já obtidos para o mesmo prompt são reaproveitados.
 */
export async function runAgent(agent: AgentName, prompt: string, opts: RunOptions = {}): Promise<string> {
  const mock = isMock();
  let cacheFile: string | null = null;
  if (opts.cacheDir) {
    const key = createHash("sha1")
      .update(`${mock ? "MOCK" : "REAL"}\0${agent}\0${await definitionHash(agent)}\0${(opts.rubrics ?? []).join(",")}\0${prompt}`)
      .digest("hex");
    cacheFile = path.join(opts.cacheDir, `${key}.txt`);
    try {
      return await fs.readFile(cacheFile, "utf8");
    } catch {}
  }

  await acquire(opts.signal);
  let out: string;
  try {
    out = mock ? await mockAgent(agent, opts) : await spawnAgent(agent, await withRubrics(agent, prompt, opts.rubrics), opts);
  } finally {
    release();
  }

  opts.validate?.(out); // resposta inválida não vai para o cache (o "retomar" a refaz)
  if (cacheFile && opts.cacheDir) {
    await fs.mkdir(opts.cacheDir, { recursive: true });
    await fs.writeFile(cacheFile, out);
  }
  return out;
}

async function cacheFileFor(agent: AgentName, prompt: string, opts: RunOptions) {
  if (!opts.cacheDir) return null;
  const key = createHash("sha1")
    .update(`${isMock() ? "MOCK" : "REAL"}\0${agent}\0${await definitionHash(agent)}\0${(opts.rubrics ?? []).join(",")}\0${prompt}`)
    .digest("hex");
  return path.join(opts.cacheDir, `${key}.txt`);
}

/** Já existe resultado guardado para esta chamada? (usado na estimativa de tokens) */
export async function peekCache(agent: AgentName, prompt: string, opts: RunOptions): Promise<boolean> {
  const f = await cacheFileFor(agent, prompt, opts);
  if (!f) return false;
  try {
    await fs.access(f);
    return true;
  } catch {
    return false;
  }
}

/** Caracteres fixos de cada chamada além da mensagem: rubricas + definição do agente + sistema. */
export async function promptOverheadChars(agent: AgentName, override?: string[]): Promise<number> {
  let n = 1800; // sistema mínimo do Claude Code no modo enxuto
  try {
    n += (await fs.readFile(path.join(ROOT, ".claude", "agents", `${agent}.md`), "utf8")).length;
  } catch {}
  for (const f of override ?? RUBRICS[agent] ?? []) {
    try {
      n += (await fs.readFile(path.join(ROOT, "knowledge", f), "utf8")).length;
    } catch {}
  }
  return n;
}
