export type StepStatus = "pending" | "running" | "done" | "error" | "cancelled";
export type StepState = {
  status: StepStatus;
  error?: string;
  kind?: "limit";
  progress?: string;
  startedAt?: string;
  completed?: number;
  total?: number;
  fraction?: number;
  outChars?: number;
  tokens?: number;
  durationMs?: number;
};
export type Job = {
  id: string;
  filename: string;
  createdAt: string;
  steps: Record<string, StepState>;
};

export type TabId =
  | "article"
  | "citacoes"
  | "resumos"
  | "portugues"
  | "estrutura"
  | "secoes"
  | "plagio"
  | "geral"
  | "relatorio";

export type Tab = {
  id: TabId;
  step: string;
  files: string[];
  label: string;
  /** Nome curto para o passo a passo */
  short: string;
  title: string;
  desc: string;
  ai: boolean;
  group: "Preparação" | "Análises" | "Resultado";
};

export const TABS: Tab[] = [
  {
    id: "article",
    step: "conversao",
    files: ["article.md"],
    label: "Artigo convertido",
    short: "Artigo",
    title: "Artigo convertido para Markdown",
    desc: "Texto extraído do arquivo, sem IA. Confira se a conversão não perdeu nada importante.",
    ai: false,
    group: "Preparação",
  },
  {
    id: "citacoes",
    step: "citacoes",
    files: ["citacoes.json"],
    label: "Citações e referências",
    short: "Citações",
    title: "Citações e referências",
    desc: "Extraídas e cruzadas automaticamente, sem IA. Você confirma manualmente se cada obra existe.",
    ai: false,
    group: "Preparação",
  },
  {
    id: "resumos",
    step: "resumos",
    files: ["resumos.md"],
    label: "Resumos (PT · EN · ES)",
    short: "Resumos",
    title: "Resumo, Abstract e Resumen",
    desc: "Correção do resumo em português, inglês e espanhol, e conferência de que os três dizem a mesma coisa.",
    ai: true,
    group: "Análises",
  },
  {
    id: "portugues",
    step: "portugues",
    files: ["portugues.md"],
    label: "Português",
    short: "Português",
    title: "Revisão de português",
    desc: "Ortografia, gramática, pontuação, clareza e registro acadêmico, trecho a trecho.",
    ai: true,
    group: "Análises",
  },
  {
    id: "estrutura",
    step: "estrutura",
    files: ["estrutura.md"],
    label: "Estrutura",
    short: "Estrutura",
    title: "Divisão em seções",
    desc: "Se as seções estão bem divididas, na ordem e na proporção certas, com sugestão de reorganização.",
    ai: true,
    group: "Análises",
  },
  {
    id: "secoes",
    step: "secoes",
    files: ["secoes.md"],
    label: "Seção a seção",
    short: "Seções",
    title: "Análise seção a seção",
    desc: "Cada seção avaliada quanto à função, lógica, evidências e método.",
    ai: true,
    group: "Análises",
  },
  {
    id: "plagio",
    step: "plagio",
    files: ["plagio.md"],
    label: "Trechos suspeitos",
    short: "Plágio",
    title: "Trechos para checar possível plágio",
    desc: "Trechos com sinais de cópia, com links de busca. Serve para você pesquisar; não confirma plágio.",
    ai: true,
    group: "Análises",
  },
  {
    id: "geral",
    step: "geral",
    files: ["geral.md", "ia.md"],
    label: "Geral e indícios de IA",
    short: "Geral e IA",
    title: "Avaliação geral e indícios de IA",
    desc: "Coerência do artigo inteiro e sinais de texto gerado por IA, com evidências e ressalvas.",
    ai: true,
    group: "Análises",
  },
  {
    id: "relatorio",
    step: "relatorio",
    files: ["relatorio.md"],
    label: "Relatório final",
    short: "Relatório",
    title: "Relatório final",
    desc: "Veredito e lista de correções priorizada — ou a declaração de que o artigo está bom.",
    ai: true,
    group: "Resultado",
  },
];

export const AI_STEPS = TABS.filter((t) => t.ai).map((t) => t.step);

export const ACCEPTED_EXTENSIONS = [".docx", ".doc", ".pdf", ".odt", ".rtf"];

/** O servidor marca como "cancelled" qualquer etapa interrompida; "running" é sempre uma execução ativa. */
export const isLive = (s?: StepState) => s?.status === "running";

/** Fração concluída (0–1) de uma etapa; null quando não há como saber. */
export function stepFraction(s: StepState | undefined): number | null {
  if (!s) return 0;
  if (s.status === "done") return 1;
  if (s.status !== "running") return 0;
  if (typeof s.fraction === "number") return Math.min(0.99, s.fraction);
  if (s.total) return Math.min(0.99, (s.completed ?? 0) / s.total);
  return null;
}

export const fmtElapsed = (ms: number) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};
