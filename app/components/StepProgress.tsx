"use client";

import { useSyncExternalStore } from "react";
import { fmtElapsed, stepFraction, type StepState } from "./types";
import { Icon } from "./Icon";

// Relógio compartilhado: só existe no navegador (no servidor o valor é fixo), então não há
// diferença entre a renderização do servidor e a do cliente (evita erro de hidratação).
let tick = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!timer) {
    tick = Date.now();
    timer = setInterval(() => {
      tick = Date.now();
      listeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    listeners.delete(cb);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
const noopSubscribe = () => () => {};

/** Hora atual, atualizada a cada segundo enquanto `active` (0 no servidor e antes de ativar). */
export function useNow(active: boolean) {
  return useSyncExternalStore(active ? subscribe : noopSubscribe, () => tick, () => 0);
}

/** Card de andamento: porcentagem real, texto gerado, tokens, tempo decorrido e botão Cancelar. */
export function StepProgress({
  state,
  onCancel,
  cancelling,
}: {
  state: StepState;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const now = useNow(true);
  const f = stepFraction(state);
  const pct = f === null ? null : Math.round(f * 100);
  const elapsed = state.startedAt && now ? fmtElapsed(now - Date.parse(state.startedAt)) : "0:00";
  const words = Math.round((state.outChars ?? 0) / 6);
  const parts = state.total && state.total > 1 ? `${state.completed ?? 0} de ${state.total} partes · ` : "";

  return (
    <div className="no-print mb-5 rounded-xl border border-accent/30 bg-accent/5 p-4">
      <div className="mb-2 flex items-end justify-between gap-3">
        <div>
          <p className="text-2xl font-semibold tabular-nums">{pct === null ? "…" : `${pct}%`}</p>
          <p className="text-xs text-muted">
            {parts}
            {words > 0 ? `${words.toLocaleString("pt-BR")} palavras geradas · ` : "iniciando a IA… · "}
            {state.tokens ? `${Math.round(state.tokens / 1000)} mil tokens · ` : ""}
            {elapsed} decorridos
          </p>
        </div>
        <button
          onClick={onCancel}
          disabled={cancelling}
          className="inline-flex items-center gap-1.5 rounded-lg border border-bad/50 px-3 py-1.5 text-sm font-medium text-bad hover:bg-bad/10 disabled:opacity-50"
        >
          <Icon name="stop" className="size-3.5" /> {cancelling ? "Cancelando…" : "Cancelar"}
        </button>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-line">
        {pct === null ? (
          <div className="indeterminate h-full" />
        ) : (
          <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${pct}%` }} />
        )}
      </div>
      <p className="mt-2 text-xs text-muted">
        A porcentagem acompanha o texto que a IA vai escrevendo. Pode atualizar a página: a análise continua e não reinicia.
        Só para se você clicar em Cancelar.
      </p>
    </div>
  );
}
