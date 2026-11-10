"use client";

import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

type View = "numerado" | "article";

/** Painel lateral com o texto do artigo: numerado (¶) ou Markdown convertido. */
export function TextDrawer({ jobId, open, onClose }: { jobId: string; open: boolean; onClose: () => void }) {
  const [view, setView] = useState<View>("numerado");
  const [data, setData] = useState<Record<string, string | null>>({});

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const file = view === "numerado" ? "numerado.md" : "article.md";
    const key = `${jobId}|${file}`;
    fetch(`/api/jobs/${jobId}/files/${file}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.text() : null))
      .then((t) => !cancelled && setData((d) => ({ ...d, [key]: t })))
      .catch(() => !cancelled && setData((d) => ({ ...d, [key]: null })));
    return () => {
      cancelled = true;
    };
  }, [open, view, jobId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const file = view === "numerado" ? "numerado.md" : "article.md";
  const text = data[`${jobId}|${file}`];

  return (
    <div className="no-print fixed inset-0 z-40">
      <button aria-label="Fechar texto" className="absolute inset-0 bg-black/30" onClick={onClose} />
      <aside
        role="dialog"
        aria-label="Texto do artigo"
        className="absolute right-0 top-0 flex h-full w-full max-w-2xl flex-col border-l border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-line p-4">
          <h2 className="font-semibold">Texto do artigo</h2>
          <div className="inline-flex rounded-lg border border-line p-0.5 text-sm">
            {(
              [
                ["numerado", "Numerado (¶)"],
                ["article", "Markdown"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setView(id)}
                aria-pressed={view === id}
                className={`rounded-md px-3 py-1 ${view === id ? "bg-accent text-accent-fg" : "text-muted hover:text-fg"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <button onClick={onClose} aria-label="Fechar" className="ml-auto text-muted hover:text-fg">
            <Icon name="x" className="size-5" />
          </button>
        </div>
        {view === "numerado" && (
          <p className="border-b border-line bg-accent/5 px-4 py-2 text-xs text-muted">
            Os números <b>¶n</b> contam os parágrafos dentro de cada seção. É a mesma numeração usada nas correções do
            relatório.
          </p>
        )}
        <div className="flex-1 overflow-y-auto p-5">
          {text === undefined ? (
            <p className="text-sm text-muted">Carregando…</p>
          ) : text === null ? (
            <p className="text-sm text-muted">Texto indisponível para esta análise.</p>
          ) : (
            <Markdown>{text}</Markdown>
          )}
        </div>
      </aside>
    </div>
  );
}
