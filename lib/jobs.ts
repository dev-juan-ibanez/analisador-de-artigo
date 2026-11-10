import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const ROOT = process.cwd();
export const JOBS_DIR = path.join(ROOT, "data", "jobs");

export const STEP_IDS = [
  "conversao",
  "citacoes",
  "resumos",
  "portugues",
  "estrutura",
  "secoes",
  "plagio",
  "geral",
  "relatorio",
] as const;
export type StepId = (typeof STEP_IDS)[number];

export type StepState = {
  status: "pending" | "running" | "done" | "error" | "cancelled";
  error?: string;
  /** "limit" = limite de uso do Claude atingido */
  kind?: "limit";
  startedAt?: string;
  finishedAt?: string;
  progress?: string;
  /** Chamadas de IA concluídas / total previsto (para a porcentagem) */
  completed?: number;
  total?: number;
  /** Andamento real (0–1): partes concluídas + texto já gerado nas partes em curso */
  fraction?: number;
  /** Caracteres gerados pela IA até agora na etapa */
  outChars?: number;
  /** Tokens usados na etapa (entrada + saída, inclui cache) */
  tokens?: number;
  durationMs?: number;
};

export type Job = {
  id: string;
  filename: string;
  createdAt: string;
  steps: Record<StepId, StepState>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidId(id: string) {
  return UUID_RE.test(id);
}

export function jobDir(id: string) {
  if (!isValidId(id)) throw new Error("id inválido");
  return path.join(JOBS_DIR, id);
}

export function jobFile(id: string, name: string) {
  return path.join(jobDir(id), name);
}

/** Arquivos que a API pode servir ao navegador. */
export const PUBLIC_FILES = [
  "article.md",
  "numerado.md",
  "citacoes.json",
  "citacoes.md",
  "resumos.md",
  "portugues.md",
  "estrutura.md",
  "secoes.md",
  "plagio.md",
  "geral.md",
  "ia.md",
  "relatorio.md",
] as const;

export async function createJob(filename: string): Promise<Job> {
  const id = randomUUID();
  await fs.mkdir(jobDir(id), { recursive: true });
  const steps = Object.fromEntries(
    STEP_IDS.map((s) => [s, { status: "pending" }]),
  ) as Record<StepId, StepState>;
  const job: Job = { id, filename, createdAt: new Date().toISOString(), steps };
  await fs.writeFile(jobFile(id, "job.json"), JSON.stringify(job, null, 2));
  return job;
}

export async function getJob(id: string): Promise<Job | null> {
  try {
    const job: Job = JSON.parse(await fs.readFile(jobFile(id, "job.json"), "utf8"));
    return await reconcileJob(job);
  } catch {
    return null;
  }
}

export async function deleteJob(id: string) {
  await fs.rm(jobDir(id), { recursive: true, force: true });
}

export async function listJobs(): Promise<Job[]> {
  let ids: string[] = [];
  try {
    ids = await fs.readdir(JOBS_DIR);
  } catch {
    return [];
  }
  const jobs = await Promise.all(ids.filter(isValidId).map(getJob));
  return jobs
    .filter((j): j is Job => !!j)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Serializa gravações de job.json por job (etapas rodam em paralelo).
const queues = new Map<string, Promise<unknown>>();
export function updateStep(id: string, step: StepId, patch: Partial<StepState>) {
  const prev = queues.get(id) ?? Promise.resolve();
  const next = prev.then(async () => {
    const job = await getJob(id);
    if (!job) return;
    job.steps[step] = { ...job.steps[step], ...patch };
    await fs.writeFile(jobFile(id, "job.json"), JSON.stringify(job, null, 2));
  });
  queues.set(id, next.catch(() => {}));
  return next;
}

export async function readOptional(id: string, name: string) {
  try {
    return await fs.readFile(jobFile(id, name), "utf8");
  } catch {
    return null;
  }
}

// ---- Execuções em andamento (compartilhado entre recarregamentos do dev server) ----
const gr = globalThis as unknown as { __analisadorRuns?: Map<string, AbortController> };
const runs: Map<string, AbortController> = (gr.__analisadorRuns ??= new Map());
const runKey = (id: string, step: string) => `${id}:${step}`;

export function registerRun(id: string, step: StepId) {
  const c = new AbortController();
  runs.set(runKey(id, step), c);
  return c;
}
export function endRun(id: string, step: StepId) {
  runs.delete(runKey(id, step));
}
export function hasActiveRun(id: string) {
  return [...runs.keys()].some((k) => k.startsWith(`${id}:`));
}
/** Cancela todas as etapas em execução do job. Retorna quantas foram canceladas. */
export function cancelRuns(id: string) {
  let n = 0;
  for (const [k, c] of runs) {
    if (k.startsWith(`${id}:`)) {
      c.abort("user");
      n++;
    }
  }
  return n;
}

/** Etapa marcada "running" sem execução ativa = servidor reiniciado: marca como interrompida. */
export async function reconcileJob(job: Job): Promise<Job> {
  let changed = false;
  for (const id of STEP_IDS) {
    const st = job.steps[id];
    if (st?.status === "running" && !runs.has(runKey(job.id, id))) {
      job.steps[id] = {
        ...st,
        status: "cancelled",
        progress: "Interrompida (o servidor foi reiniciado). Você pode retomar de onde parou.",
      };
      changed = true;
    }
  }
  if (changed) await fs.writeFile(jobFile(job.id, "job.json"), JSON.stringify(job, null, 2));
  return job;
}
