"use client";

import { useEffect, useRef, useState } from "react";
import { ACCEPTED_EXTENSIONS } from "./types";
import { Icon, Spinner } from "./Icon";

/**
 * Detecta arquivos sendo arrastados sobre a janela inteira e trata o "soltar"
 * em qualquer lugar da página (evita o navegador abrir o arquivo).
 */
export function useWindowDrop(onFile: (f: File) => void, disabled: boolean) {
  const [dragging, setDragging] = useState(false);
  const cb = useRef(onFile);
  useEffect(() => {
    cb.current = onFile;
  });

  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types?.includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      if (!disabled) setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const f = e.dataTransfer?.files?.[0];
      if (f && !disabled) cb.current(f);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [disabled]);

  return dragging;
}

export function Dropzone({
  onFile,
  busy,
  dragging,
}: {
  onFile: (f: File) => void;
  busy: boolean;
  dragging: boolean;
}) {
  return (
    <label
      className={`group relative flex cursor-pointer flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed px-6 py-16 text-center transition focus-within:ring-2 focus-within:ring-accent ${
        dragging
          ? "border-accent bg-accent/10"
          : "border-line bg-surface hover:border-accent/60"
      } ${busy ? "pointer-events-none opacity-80" : ""}`}
    >
      <input
        type="file"
        accept={ACCEPTED_EXTENSIONS.join(",")}
        className="sr-only"
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      <span
        className={`grid size-14 place-items-center rounded-full ${
          dragging ? "bg-accent text-accent-fg" : "bg-accent/10 text-accent"
        }`}
      >
        {busy ? <Spinner className="size-6" /> : <Icon name="upload" className="size-6" />}
      </span>
      {busy ? (
        <div>
          <p className="text-lg font-semibold">Convertendo para Markdown…</p>
          <p className="text-sm text-muted">Extraindo texto, citações e referências.</p>
        </div>
      ) : (
        <div>
          <p className="text-lg font-semibold">
            {dragging ? "Solte o arquivo para analisar" : "Arraste o artigo aqui"}
          </p>
          <p className="text-sm text-muted">
            ou <span className="font-medium text-accent underline underline-offset-2">escolha um arquivo</span> no computador
          </p>
        </div>
      )}
      <ul className="flex flex-wrap justify-center gap-2 text-xs text-muted">
        {ACCEPTED_EXTENSIONS.map((e) => (
          <li key={e} className="rounded-full border border-line px-2.5 py-0.5 font-mono">
            {e}
          </li>
        ))}
      </ul>
    </label>
  );
}

/** Camada que cobre a tela quando se arrasta um arquivo com uma análise aberta. */
export function DropOverlay({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-accent/20 backdrop-blur-sm">
      <div className="rounded-2xl border-2 border-dashed border-accent bg-surface px-10 py-8 text-center shadow-xl">
        <Icon name="upload" className="mx-auto mb-2 size-8 text-accent" />
        <p className="text-lg font-semibold">Solte para analisar um novo artigo</p>
      </div>
    </div>
  );
}
