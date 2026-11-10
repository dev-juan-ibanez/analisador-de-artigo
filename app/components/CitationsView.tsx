"use client";

import { useState } from "react";
import { Icon } from "./Icon";

type Ref = {
  id: number;
  raw: string;
  year: string | null;
  doi: string | null;
  citedCount: number;
  links: { doi?: string; scholar: string; crossref: string; openalex: string };
};
type Cit = { raw: string; context: string; matchedRef: number | null };
export type CitReport = {
  style: string;
  references: Ref[];
  citations: Cit[];
  citedButMissing: Cit[];
  listedButUncited: Ref[];
  warnings: string[];
};

type Mark = "ok" | "bad";
type Filter = "all" | "todo" | "ok" | "bad";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Todas" },
  { id: "todo", label: "A verificar" },
  { id: "ok", label: "Existem" },
  { id: "bad", label: "Suspeitas" },
];

function Stat({ value, label, tone }: { value: number; label: string; tone?: "warn" }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className={`text-2xl font-semibold ${tone === "warn" && value > 0 ? "text-warn" : ""}`}>{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}

export function CitationsView({ jobId, report }: { jobId: string; report: CitReport }) {
  const key = `checks:${jobId}`;
  const [marks, setMarks] = useState<Record<number, Mark>>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "{}");
    } catch {
      return {};
    }
  });
  const [filter, setFilter] = useState<Filter>("all");

  const toggle = (id: number, v: Mark) => {
    const next = { ...marks };
    if (next[id] === v) delete next[id];
    else next[id] = v;
    setMarks(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {}
  };

  const total = report.references.length;
  const checked = Object.keys(marks).length;
  const bad = Object.values(marks).filter((m) => m === "bad").length;
  const visible = report.references.filter((r) =>
    filter === "all" ? true : filter === "todo" ? !marks[r.id] : marks[r.id] === filter,
  );
  const count = (f: Filter) =>
    f === "all" ? total : f === "todo" ? total - checked : Object.values(marks).filter((m) => m === f).length;

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat value={report.citations.length} label="Citações no texto" />
        <Stat value={total} label="Referências na lista" />
        <Stat value={report.citedButMissing.length} label="Citadas e ausentes da lista" tone="warn" />
        <Stat value={report.listedButUncited.length} label="Listadas e nunca citadas" tone="warn" />
      </div>

      {report.warnings.map((w) => (
        <p key={w} className="flex gap-2 rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm">
          <Icon name="alert" className="mt-0.5 size-4 shrink-0 text-warn" />
          {w}
        </p>
      ))}

      {report.citedButMissing.length > 0 && (
        <details className="rounded-xl border border-line bg-surface p-4" open>
          <summary className="cursor-pointer font-semibold">
            Citadas no texto, ausentes da lista ({report.citedButMissing.length})
          </summary>
          <ul className="mt-3 space-y-2 text-sm">
            {report.citedButMissing.map((c, i) => (
              <li key={i}>
                <b>{c.raw}</b>
                <span className="block text-muted">…{c.context}…</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {report.listedButUncited.length > 0 && (
        <details className="rounded-xl border border-line bg-surface p-4">
          <summary className="cursor-pointer font-semibold">
            Na lista, nunca citadas ({report.listedButUncited.length})
          </summary>
          <ul className="mt-3 space-y-2 text-sm">
            {report.listedButUncited.map((r) => (
              <li key={r.id}>
                <span className="text-muted">[{r.id}]</span> {r.raw}
              </li>
            ))}
          </ul>
        </details>
      )}

      <section>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="font-semibold">Checagem manual das referências</h3>
            <p className="max-w-prose text-sm text-muted">
              Abra os links e confirme que título, autores e ano batem. Um DOI que resolve pode apontar para outro artigo.
              Suas marcações ficam salvas neste navegador.
            </p>
          </div>
          <div className="min-w-48">
            <div className="mb-1 flex justify-between text-xs text-muted">
              <span>
                {checked}/{total} verificadas
              </span>
              {bad > 0 && <span className="text-bad">{bad} suspeita(s)</span>}
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-line">
              <div
                className="h-full rounded-full bg-ok transition-all"
                style={{ width: `${total ? (checked / total) * 100 : 0}%` }}
              />
            </div>
          </div>
        </div>

        <div className="mb-3 inline-flex rounded-lg border border-line bg-surface p-0.5 text-sm" role="tablist">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={`rounded-md px-3 py-1 ${
                filter === f.id ? "bg-accent text-accent-fg" : "text-muted hover:text-fg"
              }`}
            >
              {f.label} <span className="opacity-70">{count(f.id)}</span>
            </button>
          ))}
        </div>

        {visible.length === 0 && <p className="py-6 text-center text-sm text-muted">Nenhuma referência neste filtro.</p>}

        <ol className="space-y-2">
          {visible.map((r) => {
            const m = marks[r.id];
            return (
              <li
                key={r.id}
                className={`rounded-xl border p-3 text-sm ${
                  m === "ok"
                    ? "border-ok/50 bg-ok/10"
                    : m === "bad"
                      ? "border-bad/50 bg-bad/10"
                      : "border-line bg-surface"
                }`}
              >
                <div className="flex items-start gap-3">
                  <span className="w-6 shrink-0 text-muted">{r.id}.</span>
                  <div className="min-w-0 flex-1">
                    <p className="break-words">{r.raw}</p>
                    <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      {r.links.doi ? (
                        <a className="text-accent underline" href={r.links.doi} target="_blank" rel="noreferrer">
                          DOI
                        </a>
                      ) : (
                        <span className="text-muted">sem DOI</span>
                      )}
                      <a className="text-accent underline" href={r.links.scholar} target="_blank" rel="noreferrer">
                        Scholar
                      </a>
                      <a className="text-accent underline" href={r.links.crossref} target="_blank" rel="noreferrer">
                        Crossref
                      </a>
                      <a className="text-accent underline" href={r.links.openalex} target="_blank" rel="noreferrer">
                        OpenAlex
                      </a>
                      <span className="text-muted">citada {r.citedCount}×</span>
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      onClick={() => toggle(r.id, "ok")}
                      aria-pressed={m === "ok"}
                      title="Existe e confere"
                      className={`grid size-8 place-items-center rounded-lg border ${
                        m === "ok" ? "border-ok bg-ok text-bg" : "border-line hover:bg-ok/15"
                      }`}
                    >
                      <Icon name="check" />
                    </button>
                    <button
                      onClick={() => toggle(r.id, "bad")}
                      aria-pressed={m === "bad"}
                      title="Suspeita / não encontrada"
                      className={`grid size-8 place-items-center rounded-lg border ${
                        m === "bad" ? "border-bad bg-bad text-bg" : "border-line hover:bg-bad/15"
                      }`}
                    >
                      <Icon name="x" />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
