"use client";

import { useEffect, useState } from "react";
import { CitationsView, type CitReport } from "./components/CitationsView";
import { DropOverlay, Dropzone, useWindowDrop } from "./components/Dropzone";
import { Icon, Spinner } from "./components/Icon";
import { Markdown } from "./components/Markdown";
import { StepProgress } from "./components/StepProgress";
import { TextDrawer } from "./components/TextDrawer";
import {
  ACCEPTED_EXTENSIONS,
  AI_STEPS,
  TABS,
  isLive,
  stepFraction,
  type Job,
  type Tab,
  type TabId,
} from "./components/types";

type View = "novo" | "historico" | "analise";

const WIZARD: Tab[] = TABS.filter((t) => t.id !== "article");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });

const anyLive = (j: Job) => Object.values(j.steps).some(isLive);

/** Primeira etapa ainda não concluída (a "fronteira" do fluxo). */
const frontierOf = (j: Job) => {
  const i = WIZARD.findIndex((t) => j.steps[t.step]?.status !== "done");
  return i === -1 ? WIZARD.length - 1 : i;
};
const touchedAi = (j: Job) => AI_STEPS.some((s) => (j.steps[s]?.status ?? "pending") !== "pending");
const startTab = (j: Job): TabId => {
  const running = WIZARD.find((t) => isLive(j.steps[t.step]));
  if (running) return running.id; // volta direto para a etapa em andamento
  if (j.steps.relatorio?.status === "done") return "relatorio";
  return touchedAi(j) ? WIZARD[frontierOf(j)].id : "citacoes";
};

/** Progresso geral (0–100) somando as frações de cada etapa. */
const overallPct = (j: Job) =>
  Math.round((WIZARD.reduce((n, t) => n + (stepFraction(j.steps[t.step]) ?? 0), 0) / WIZARD.length) * 100);

function jobLabel(j: Job): { text: string; tone: string } {
  const live = WIZARD.find((t) => isLive(j.steps[t.step]));
  if (live) return { text: `Analisando: ${live.label}`, tone: "text-warn" };
  if (j.steps.relatorio?.status === "done") return { text: "Relatório pronto", tone: "text-ok" };
  const stuck = WIZARD.find((t) => ["error", "cancelled"].includes(j.steps[t.step]?.status ?? ""));
  if (stuck) return { text: `Parada em: ${stuck.label}`, tone: "text-bad" };
  const done = AI_STEPS.filter((s) => j.steps[s]?.status === "done").length;
  return { text: done === 0 ? "Aguardando análise" : `Etapa ${done + 1} de ${WIZARD.length}`, tone: "text-muted" };
}

/** Extrai o veredito do relatório final para destacar no topo. */
function verdictOf(md: string): { text: string; tone: string } | null {
  const m = /\*\*Veredito:\s*([^*\n]+?)\s*\*\*/i.exec(md);
  if (!m) return null;
  const text = m[1].replace(/[<>]/g, "").trim();
  const t = text.toLowerCase();
  const tone = t.includes("sem correç")
    ? "border-ok/50 bg-ok/10 text-ok"
    : t.includes("ajustes menores")
      ? "border-warn/50 bg-warn/10 text-warn"
      : "border-bad/50 bg-bad/10 text-bad";
  return { text, tone };
}

const fmtTokens = (t?: number | null) =>
  t == null ? "" : t < 1000 ? `≈ ${Math.max(100, Math.round(t / 100) * 100)} tokens` : `≈ ${Math.round(t / 1000)} mil tokens`;

function Bar({ pct, tone = "bg-accent" }: { pct: number; tone?: string }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full rounded-full transition-all duration-700 ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function Home() {
  const [view, setView] = useState<View>("novo");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [tab, setTab] = useState<TabId>("citacoes");
  const [doc, setDoc] = useState<{ key: string; texts: string[] } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [est, setEst] = useState<Record<string, number | null>>({});

  const anyRunning = jobs.some(anyLive) || (!!job && anyLive(job));

  const apply = (j: Job) => {
    setJob((cur) => (cur && cur.id !== j.id ? cur : j));
    setJobs((prev) => (prev.some((x) => x.id === j.id) ? prev.map((x) => (x.id === j.id ? j : x)) : [j, ...prev]));
  };

  const setHash = (h: string) =>
    window.history.replaceState(null, "", h ? `#${h}` : window.location.pathname + window.location.search);

  // Carga inicial: lista de análises e, se houver #id / #historico no endereço, reabre (F5 não perde nada).
  useEffect(() => {
    fetch("/api/jobs")
      .then((r) => (r.ok ? r.json() : []))
      .then(setJobs)
      .catch(() => {});
    const h = window.location.hash.slice(1);
    if (h === "historico") queueMicrotask(() => setView("historico"));
    else if (UUID.test(h)) {
      fetch(`/api/jobs/${h}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j: Job | null) => {
          if (!j) return;
          setJob(j);
          setTab(startTab(j));
          setView("analise");
        })
        .catch(() => {});
    }
  }, []);

  // Atualização periódica (só leitura: nunca inicia nem reinicia nada)
  useEffect(() => {
    const t = setInterval(
      async () => {
        if (view === "analise" && job) {
          const r = await fetch(`/api/jobs/${job.id}`).catch(() => null);
          if (r?.ok) apply(await r.json());
        } else if (view === "historico") {
          const r = await fetch("/api/jobs").catch(() => null);
          if (r?.ok) setJobs(await r.json());
        }
      },
      anyRunning ? 2500 : 10000,
    );
    return () => clearInterval(t);
  }, [view, job?.id, anyRunning]); // eslint-disable-line react-hooks/exhaustive-deps

  const idx = Math.max(0, WIZARD.findIndex((t) => t.id === tab));
  const current = WIZARD[idx];
  const state = job?.steps[current.step];
  const tabKey = `${job?.id}|${tab}`;
  const geralStatus = job?.steps.geral?.status;

  // Carrega o(s) arquivo(s) da etapa; recarrega quando ela muda de status
  useEffect(() => {
    if (!job || view !== "analise") return;
    const id = job.id;
    const files = current.files;
    let cancelled = false;
    (async () => {
      const texts: string[] = [];
      for (const f of files) {
        const r = await fetch(`/api/jobs/${id}/files/${f}`, { cache: "no-store" }).catch(() => null);
        if (r?.ok) texts.push(await r.text());
      }
      if (!cancelled) setDoc({ key: tabKey, texts });
    })();
    return () => {
      cancelled = true;
    };
  }, [tabKey, state?.status, geralStatus, view]); // eslint-disable-line react-hooks/exhaustive-deps

  // Estimativa de tokens (sem gastar nada) da etapa atual e da próxima, para mostrar nos botões de iniciar
  const nextStep = WIZARD[idx + 1]?.step;
  const curStep = current.step;
  const curStatus = state?.status;
  const nextStatusKey = nextStep ? job?.steps[nextStep]?.status : undefined;
  useEffect(() => {
    if (!job || view !== "analise") return;
    const id = job.id;
    let cancelled = false;
    for (const st of [curStep, nextStep]) {
      if (!st || st === "citacoes") continue;
      fetch(`/api/jobs/${id}/estimate/${st}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => !cancelled && setEst((e) => ({ ...e, [`${id}:${st}`]: d?.tokens ?? null })))
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [job?.id, view, curStep, nextStep, curStatus, nextStatusKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const loaded = doc?.key === tabKey;
  const texts = loaded ? doc.texts : [];
  const raw = texts.join("\n\n---\n\n");

  async function openJob(id: string, to?: TabId) {
    const r = await fetch(`/api/jobs/${id}`);
    if (!r.ok) return;
    const j: Job = await r.json();
    setJob(j);
    setJobs((prev) => (prev.some((x) => x.id === j.id) ? prev.map((x) => (x.id === j.id ? j : x)) : [j, ...prev]));
    setTab(to ?? startTab(j));
    setView("analise");
    setError(null);
    setDrawer(false);
    setHash(j.id);
  }

  async function upload(file: File) {
    const ext = "." + (file.name.split(".").pop() ?? "").toLowerCase();
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      setError(`Formato "${ext}" não suportado. Use ${ACCEPTED_EXTENSIONS.join(", ")}.`);
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/jobs", { method: "POST", body: fd });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error ?? "Falha no envio.");
        if (data.id) await openJob(data.id, "citacoes");
        return;
      }
      // Só converte e extrai citações. A análise de IA começa quando VOCÊ clicar em "Próximo".
      await openJob(data.id, "citacoes");
    } catch {
      setError("Não consegui falar com o servidor. Ele está rodando (npm run dev)?");
    } finally {
      setUploading(false);
    }
  }

  async function run(step: string, force = false) {
    if (!job) return;
    setError(null);
    const r = await fetch(`/api/jobs/${job.id}/run/${step}${force ? "?force=1" : ""}`, { method: "POST" });
    if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? "Falha ao iniciar a etapa.");
    const j = await fetch(`/api/jobs/${job.id}`);
    if (j.ok) apply(await j.json());
  }

  async function cancel() {
    if (!job) return;
    if (!window.confirm("Cancelar a análise em andamento?\n\nO que já foi analisado fica guardado e você poderá retomar de onde parou.")) return;
    setCancelling(true);
    try {
      const r = await fetch(`/api/jobs/${job.id}/cancel`, { method: "POST" });
      const d = await r.json().catch(() => null);
      if (d?.job) apply(d.job);
    } finally {
      setCancelling(false);
    }
  }

  async function remove(j: Job) {
    if (!window.confirm(`Excluir a análise de "${j.filename}"?\n\nO arquivo, o texto convertido e todos os resultados serão apagados. Isso não pode ser desfeito.`)) return;
    const r = await fetch(`/api/jobs/${j.id}`, { method: "DELETE" });
    if (!r.ok) {
      setError((await r.json().catch(() => ({}))).error ?? "Não foi possível excluir.");
      return;
    }
    setJobs((prev) => prev.filter((x) => x.id !== j.id));
    if (job?.id === j.id) {
      setJob(null);
      setView("historico");
      setHash("historico");
    }
  }

  function go(v: View) {
    setView(v);
    setError(null);
    setDrawer(false);
    setHash(v === "historico" ? "historico" : v === "analise" && job ? job.id : "");
  }

  const goStep = (i: number) => {
    setTab(WIZARD[i].id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /** "Próximo": só avança com o clique e, se a próxima etapa ainda não rodou, inicia ela (uma por vez). */
  async function next() {
    if (!job) return;
    const n = WIZARD[idx + 1];
    const st = job.steps[n.step]?.status;
    if (st !== "done" && st !== "running") await run(n.step);
    goStep(idx + 1);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  const dragging = useWindowDrop((f) => void upload(f), uploading);

  const live = isLive(state);
  const isLast = idx === WIZARD.length - 1;
  const nextTab = isLast ? null : WIZARD[idx + 1];
  const nextStatus = nextTab ? job?.steps[nextTab.step]?.status : undefined;
  const currentOk = !current.ai || state?.status === "done";
  const nextBusy = nextStatus !== "done" && nextStatus !== "running" && anyRunning;
  const canNext = currentOk && !nextBusy;
  const nextEst = job && nextTab ? est[`${job.id}:${nextTab.step}`] : null;
  const curEst = job ? est[`${job.id}:${current.step}`] : null;
  const nextLabel =
    nextStatus === "done"
      ? "Próximo"
      : nextStatus === "running"
        ? "Ver andamento"
        : `Iniciar: ${nextTab?.label}${nextEst ? ` (${fmtTokens(nextEst)})` : ""}`;
  const frontier = job ? frontierOf(job) : 0;
  const verdict = tab === "relatorio" && raw ? verdictOf(raw) : null;
  const resumable = state?.status === "cancelled" || state?.status === "error";
  const pct = job ? overallPct(job) : 0;

  return (
    <div className="min-h-screen pb-24">
      <DropOverlay show={dragging && view === "analise"} />
      {job && <TextDrawer jobId={job.id} open={drawer} onClose={() => setDrawer(false)} />}

      {/* ---------- Cabeçalho ---------- */}
      <header className="no-print sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <button onClick={() => go("novo")} className="flex items-center gap-2.5" aria-label="Página inicial">
            <span className="grid size-8 place-items-center rounded-lg bg-accent text-accent-fg">
              <Icon name="sparkle" />
            </span>
            <span className="hidden text-base font-semibold sm:block">Analisador de Artigo Científico</span>
          </button>
          <nav className="ml-auto flex items-center gap-1" aria-label="Principal">
            {(
              [
                ["novo", "Novo", "plus"],
                ["historico", "Histórico", "history"],
              ] as const
            ).map(([v, label, icon]) => (
              <button
                key={v}
                onClick={() => go(v)}
                aria-current={view === v ? "page" : undefined}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition ${
                  view === v ? "bg-accent/10 font-medium text-accent" : "text-muted hover:bg-fg/5 hover:text-fg"
                }`}
              >
                <Icon name={icon} /> {label}
                {v === "historico" && jobs.length > 0 && (
                  <span className="rounded-full bg-fg/10 px-1.5 text-[11px] tabular-nums">{jobs.length}</span>
                )}
              </button>
            ))}
          </nav>
        </div>

        {/* Barra do artigo aberto */}
        {view === "analise" && job && (
          <div className="border-t border-line bg-surface/70">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 sm:px-6">
              <button onClick={() => go("historico")} className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
                <Icon name="back" className="size-3.5" /> Histórico
              </button>
              <span className="text-muted">/</span>
              <h2 className="min-w-0 flex-1 truncate text-sm font-medium" title={job.filename}>
                {job.filename}
              </h2>
              <div className="flex w-full items-center gap-3 sm:w-64">
                <div className="flex-1">
                  <Bar pct={pct} tone={job.steps.relatorio?.status === "done" ? "bg-ok" : "bg-accent"} />
                </div>
                <span className="w-9 text-right text-xs tabular-nums text-muted">{pct}%</span>
              </div>
              <button
                onClick={() => setDrawer(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1 text-sm hover:border-accent hover:text-accent"
              >
                <Icon name="file" /> Texto numerado
              </button>
            </div>
          </div>
        )}
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        {error && (
          <div role="alert" className="no-print mb-4 flex items-start gap-2 rounded-xl border border-bad/40 bg-bad/10 p-3 text-sm">
            <Icon name="alert" className="mt-0.5 size-4 shrink-0 text-bad" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} aria-label="Fechar aviso" className="text-muted hover:text-fg">
              <Icon name="x" />
            </button>
          </div>
        )}

        {/* ---------- Novo ---------- */}
        {view === "novo" && (
          <div className="mx-auto max-w-3xl space-y-8">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">Analise um artigo científico</h2>
              <p className="mt-1 max-w-prose text-muted">
                Envie o arquivo e avance uma etapa por vez, no seu ritmo. No fim, um relatório com a visão geral e as
                correções seção a seção, parágrafo a parágrafo — ou a confirmação de que o artigo está bom.
              </p>
            </div>
            <Dropzone onFile={(f) => void upload(f)} busy={uploading} dragging={dragging} />
            <section>
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">As etapas</h3>
              <ol className="grid gap-3 sm:grid-cols-2">
                {WIZARD.map((t, i) => (
                  <li key={t.id} className="flex gap-3 rounded-xl border border-line bg-surface p-3">
                    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent/10 text-xs font-semibold text-accent">
                      {i + 1}
                    </span>
                    <div>
                      <p className="text-sm font-medium">
                        {t.label}{" "}
                        <span className="ml-1 rounded-full border border-line px-1.5 py-0.5 text-[10px] font-normal text-muted">
                          {t.ai ? "IA" : "sem IA"}
                        </span>
                      </p>
                      <p className="text-xs text-muted">{t.desc}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}

        {/* ---------- Histórico ---------- */}
        {view === "historico" && (
          <div className="space-y-4">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h2 className="text-2xl font-semibold tracking-tight">Histórico</h2>
                <p className="text-sm text-muted">Artigos já enviados. Abra para continuar de onde parou.</p>
              </div>
              <button
                onClick={() => go("novo")}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:opacity-90"
              >
                <Icon name="plus" /> Novo artigo
              </button>
            </div>
            {jobs.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-line p-10 text-center text-sm text-muted">
                Nenhuma análise ainda.
              </div>
            ) : (
              <ul className="space-y-2">
                {jobs.map((j) => {
                  const l = jobLabel(j);
                  const p = overallPct(j);
                  return (
                    <li key={j.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-surface p-4">
                      <Icon name="file" className="size-5 shrink-0 text-muted" />
                      <div className="min-w-0 flex-1 basis-60">
                        <p className="truncate font-medium" title={j.filename}>
                          {j.filename}
                        </p>
                        <p className="text-xs text-muted">Enviado em {fmtDate(j.createdAt)}</p>
                      </div>
                      <div className="w-40">
                        <div className="mb-1 flex justify-between text-xs">
                          <span className={`inline-flex items-center gap-1 ${l.tone}`}>
                            {anyLive(j) && <Spinner className="size-3" />}
                            {l.text}
                          </span>
                          <span className="tabular-nums text-muted">{p}%</span>
                        </div>
                        <Bar pct={p} tone={j.steps.relatorio?.status === "done" ? "bg-ok" : "bg-accent"} />
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => openJob(j.id)}
                          className="rounded-lg border border-line px-3 py-1.5 text-sm hover:border-accent hover:text-accent"
                        >
                          Abrir
                        </button>
                        <button
                          onClick={() => remove(j)}
                          disabled={anyLive(j)}
                          aria-label={`Excluir ${j.filename}`}
                          title={anyLive(j) ? "Cancele a análise antes de excluir" : "Excluir"}
                          className="grid size-9 place-items-center rounded-lg border border-line text-muted hover:border-bad hover:text-bad disabled:opacity-40"
                        >
                          <Icon name="trash" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {/* ---------- Análise (etapas) ---------- */}
        {view === "analise" && job && (
          <div className="space-y-5">
            <nav aria-label="Etapas" className="no-print overflow-x-auto pb-1">
              <ol className="flex min-w-max items-center">
                {WIZARD.map((t, i) => {
                  const s = job.steps[t.step];
                  const active = i === idx;
                  const locked = i > frontier && (s?.status ?? "pending") === "pending";
                  return (
                    <li key={t.id} className="flex items-center">
                      <button
                        onClick={() => goStep(i)}
                        disabled={locked}
                        aria-current={active ? "step" : undefined}
                        title={locked ? "Conclua a etapa anterior e clique em Próximo" : t.title}
                        className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition disabled:cursor-not-allowed disabled:opacity-40 ${
                          active ? "bg-accent/10 font-medium text-accent" : "text-muted hover:text-fg"
                        }`}
                      >
                        <span
                          className={`grid size-6 shrink-0 place-items-center rounded-full border text-xs ${
                            s?.status === "done"
                              ? "border-ok bg-ok text-bg"
                              : s?.status === "error" || s?.status === "cancelled"
                                ? "border-bad text-bad"
                                : active
                                  ? "border-accent text-accent"
                                  : "border-line"
                          }`}
                        >
                          {isLive(s) ? (
                            <Spinner className="size-3.5" />
                          ) : s?.status === "done" ? (
                            <Icon name="check" className="size-3.5" />
                          ) : s?.status === "error" || s?.status === "cancelled" ? (
                            "!"
                          ) : (
                            i + 1
                          )}
                        </span>
                        <span className="hidden lg:inline">{t.short}</span>
                      </button>
                      {i < WIZARD.length - 1 && <span className="mx-0.5 h-px w-4 bg-line" />}
                    </li>
                  );
                })}
              </ol>
            </nav>

            <section className="print-area min-w-0 rounded-2xl border border-line bg-surface p-4 sm:p-6">
              <div className="no-print mb-5 flex flex-wrap items-start justify-between gap-3">
                <div className="max-w-prose">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted">
                    Etapa {idx + 1} de {WIZARD.length} · {current.ai ? "IA" : "sem IA"}
                  </p>
                  <h2 className="text-xl font-semibold">{current.title}</h2>
                  <p className="text-sm text-muted">{current.desc}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {current.ai && state?.status === "done" && (
                    <button
                      onClick={() => {
                        if (window.confirm("Refazer do zero? Isso descarta o resultado desta etapa e gasta a análise de IA novamente.")) void run(current.step, true);
                      }}
                      disabled={anyRunning}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Icon name="retry" /> Refazer
                    </button>
                  )}
                  {raw && !live && (
                    <>
                      <button
                        onClick={copy}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 hover:border-accent hover:text-accent"
                      >
                        <Icon name={copied ? "check" : "copy"} /> {copied ? "Copiado" : "Copiar"}
                      </button>
                      <a
                        href={`/api/jobs/${job.id}/files/${tab === "citacoes" ? "citacoes.md" : current.files[0]}`}
                        download={`${job.filename.replace(/\.[^.]+$/, "")}-${tab}.md`}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 hover:border-accent hover:text-accent"
                      >
                        <Icon name="download" /> .md
                      </a>
                      {tab === "relatorio" && (
                        <button
                          onClick={() => window.print()}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 hover:border-accent hover:text-accent"
                        >
                          <Icon name="print" /> Imprimir / PDF
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {job.steps.conversao?.progress && tab === "citacoes" && (
                <p className="no-print mb-4 flex gap-2 text-xs text-muted">
                  <Icon name="alert" className="size-3.5 shrink-0" />
                  {job.steps.conversao.progress}
                </p>
              )}

              {live && state && <StepProgress state={state} onCancel={cancel} cancelling={cancelling} />}

              {resumable && state && (
                <div
                  className={`no-print mb-5 rounded-xl border p-4 text-sm ${
                    state.status === "cancelled" ? "border-warn/40 bg-warn/10" : "border-bad/40 bg-bad/10"
                  }`}
                >
                  <p className={`mb-1 font-semibold ${state.status === "cancelled" ? "text-warn" : "text-bad"}`}>
                    {state.status === "cancelled"
                      ? "Etapa cancelada"
                      : state.kind === "limit"
                        ? "Limite de uso do Claude atingido"
                        : "A etapa falhou"}
                  </p>
                  <p className="mb-3 whitespace-pre-wrap break-words text-muted">
                    {state.status === "cancelled" ? state.progress : state.error}
                    {(state.completed ?? 0) > 0 && state.total
                      ? `\nJá analisado e guardado: ${state.completed} de ${state.total} partes.`
                      : ""}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => run(current.step)}
                      disabled={anyRunning}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 font-medium text-accent-fg disabled:opacity-40"
                    >
                      <Icon name="play" /> Retomar de onde parou{curEst ? ` (${fmtTokens(curEst)} restantes)` : ""}
                    </button>
                    <button
                      onClick={() => run(current.step, true)}
                      disabled={anyRunning}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 hover:border-accent disabled:opacity-40"
                    >
                      <Icon name="retry" /> Refazer do zero
                    </button>
                  </div>
                </div>
              )}

              {verdict && (
                <div className={`mb-5 rounded-xl border px-4 py-3 ${verdict.tone}`}>
                  <p className="text-xs font-semibold uppercase tracking-wide opacity-80">Veredito</p>
                  <p className="text-lg font-semibold">{verdict.text}</p>
                </div>
              )}

              {!loaded ? (
                <div className="space-y-3" aria-busy="true">
                  <div className="h-4 w-1/3 animate-pulse rounded bg-line" />
                  <div className="h-4 w-full animate-pulse rounded bg-line" />
                  <div className="h-4 w-5/6 animate-pulse rounded bg-line" />
                </div>
              ) : !raw ? (
                !live &&
                !resumable && (
                  <div className="no-print grid place-items-center gap-3 rounded-xl border border-dashed border-line py-14 text-center">
                    <p className="max-w-sm text-sm text-muted">
                      Esta etapa ainda não foi iniciada. {current.ai && "A análise de IA só começa quando você clica em iniciar."}
                    </p>
                    {current.ai && (
                      <button
                        onClick={() => run(current.step)}
                        disabled={anyRunning}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-40"
                      >
                        <Icon name="play" /> Iniciar {current.label.toLowerCase()}{curEst ? ` (${fmtTokens(curEst)})` : ""}
                      </button>
                    )}
                  </div>
                )
              ) : tab === "citacoes" ? (
                <CitationsSafe jobId={job.id} json={texts[0]} />
              ) : (
                <Markdown>{raw}</Markdown>
              )}
            </section>
          </div>
        )}
      </main>

      {/* ---------- Rodapé de navegação entre etapas ---------- */}
      {view === "analise" && job && (
        <footer className="no-print fixed inset-x-0 bottom-0 z-10 border-t border-line bg-bg/90 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
            <button
              onClick={() => goStep(idx - 1)}
              disabled={idx === 0}
              className="rounded-lg border border-line px-4 py-2 text-sm hover:border-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              ← Voltar
            </button>
            <p className="flex-1 text-center text-xs text-muted">
              {live
                ? "Análise em andamento — o botão Próximo libera quando terminar"
                : !currentOk
                  ? "Conclua esta etapa para avançar"
                  : `Etapa ${idx + 1} de ${WIZARD.length}`}
            </p>
            {isLast ? (
              <button onClick={() => go("historico")} className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-accent-fg hover:opacity-90">
                Concluir
              </button>
            ) : (
              <button
                onClick={next}
                disabled={!canNext}
                className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {nextLabel} <span aria-hidden="true">→</span>
              </button>
            )}
          </div>
        </footer>
      )}
    </div>
  );
}

function CitationsSafe({ jobId, json }: { jobId: string; json: string }) {
  let report: CitReport | null = null;
  try {
    report = JSON.parse(json) as CitReport;
  } catch {}
  if (!report) return <p className="text-sm text-muted">Não consegui ler o relatório de citações.</p>;
  return <CitationsView jobId={jobId} report={report} />;
}
