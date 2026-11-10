/**
 * Dados da "leitura integrada" (uma leitura de cada trecho) e tudo o que o código faz com eles
 * SEM gastar tokens: apresentação, conferência dos endereços/trechos e montagem de tabelas.
 */
import type { NumberedSection } from "./numbering";

export type Row3 = [string, number, string, string, string];
export type Leitura = {
  pt: Row3[]; // [seção, ¶, sev, trecho, correção]
  sc: { s: string; v: string; p: [number, string, string, string][] }[]; // por seção: veredito + problemas [¶, sev, trecho, texto]
  pl: [string, number, string, string, string, string][]; // [seção, ¶, risco, trecho, motivo, consulta]
  dg: [string, string][]; // [seção, síntese]
  ia: [string, number, string, string][]; // [seção, ¶, sinal, trecho]
};
export type Saved = { key: string; order: string[]; data: Leitura };

export const emptyLeitura = (): Leitura => ({ pt: [], sc: [], pl: [], dg: [], ia: [] });

/** Aceita cercas de código e vírgulas sobrando (erros comuns), mas exige JSON de verdade. */
export function parseLeitura(text: string): Leitura {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("Resposta do agente sem JSON.");
  const body = text.slice(a, b + 1).replace(/,\s*([}\]])/g, "$1");
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(body);
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

export const merge = (parts: Leitura[]): Leitura => {
  const d = emptyLeitura();
  for (const x of parts) {
    d.pt.push(...x.pt);
    d.sc.push(...x.sc);
    d.pl.push(...x.pl);
    d.dg.push(...x.dg);
    d.ia.push(...x.ia);
  }
  return d;
};

// ---------- utilidades ----------
export const SEV = { A: "🔴", B: "🟠", C: "🟡" } as const;
export type SevKey = keyof typeof SEV;
export const sevOf = (x: unknown): SevKey => (["A", "B", "C"].includes(String(x).toUpperCase()) ? (String(x).toUpperCase() as SevKey) : "C");
export const VERDICT: Record<string, string> = { A: "Adequada", B: "Ajustes menores", C: "Revisão substancial", D: "Inadequada" };
export const RISK: Record<string, string> = { A: "alto", M: "médio", B: "baixo" };

export const cell = (x: unknown) => String(x ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
export const norm = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Casa o nome de seção devolvido pelo agente com o título real do documento. */
export function canon(order: string[], name: unknown): string {
  const n = norm(String(name ?? ""));
  return (
    order.find((t) => norm(t) === n) ??
    order.find((t) => n && (norm(t).includes(n) || n.includes(norm(t)))) ??
    String(name ?? "(sem seção)")
  );
}

// ---------- conferência dos endereços e trechos (sem tokens) ----------
const flat = (t: string) =>
  t
    .replace(/[*_`]/g, "")
    .replace(/[“”«»"]/g, '"')
    .replace(/[‘’´`]/g, "'")
    .replace(/…|\.{3}/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

export const UNVERIFIED = "⚠️ ";

/**
 * Para cada trecho citado pela IA: confere se ele existe no parágrafo indicado; se estiver em outro parágrafo
 * (ou outra seção), corrige o endereço; se não existir em lugar nenhum, marca com ⚠️ ("conferir").
 * A frase de busca de plágio, se não for literal, é descartada (nada de link com texto inventado).
 */
export function verifyLeitura(data: Leitura, sections: NumberedSection[]): { data: Leitura; fixed: number; flagged: number } {
  const order = sections.map((s) => s.title);
  const paras = new Map(sections.map((s) => [s.title, s.paras.map(flat)]));
  let fixed = 0;
  let flagged = 0;

  const locate = (sec: string, par: number, trecho: string, anySection: boolean) => {
    const needle = flat(trecho.replace(UNVERIFIED, ""));
    if (needle.length < 6) return { sec, par, ok: true }; // curto demais para conferir
    const inSec = paras.get(sec);
    if (inSec?.[par - 1]?.includes(needle)) return { sec, par, ok: true };
    const idx = inSec?.findIndex((p) => p.includes(needle)) ?? -1;
    if (idx >= 0) return { sec, par: idx + 1, ok: true, moved: true };
    if (anySection)
      for (const [t, ps] of paras) {
        const i = ps.findIndex((p) => p.includes(needle));
        if (i >= 0) return { sec: t, par: i + 1, ok: true, moved: true };
      }
    return { sec, par, ok: false };
  };

  const fixRow = (sec: string, par: number, trecho: string, anySection: boolean) => {
    const s = canon(order, sec);
    const r = locate(s, Number(par) || 0, trecho, anySection);
    if ("moved" in r && r.moved) fixed++;
    if (!r.ok) flagged++;
    return { sec: r.sec, par: r.par, trecho: r.ok ? trecho.replace(UNVERIFIED, "") : UNVERIFIED + trecho.replace(UNVERIFIED, "") };
  };

  const out = emptyLeitura();
  for (const r of data.pt) {
    const f = fixRow(String(r[0]), r[1], String(r[3] ?? ""), true);
    out.pt.push([f.sec, f.par, r[2], f.trecho, r[4]]);
  }
  for (const sc of data.sc) {
    const sec = canon(order, sc.s);
    out.sc.push({
      s: sec,
      v: sc.v,
      p: (Array.isArray(sc.p) ? sc.p : []).map((p) => {
        const f = fixRow(sec, p[0], String(p[2] ?? ""), false);
        return [f.par, p[1], f.trecho, p[3]] as [number, string, string, string];
      }),
    });
  }
  for (const r of data.pl) {
    const f = fixRow(String(r[0]), r[1], String(r[3] ?? ""), true);
    let q = String(r[5] ?? "");
    let motivo = String(r[4] ?? "");
    const hay = [...paras.values()].flat();
    if (q && !hay.some((p) => p.includes(flat(q)))) {
      q = "";
      motivo += " (frase de busca não localizada no texto: sem link)";
    }
    out.pl.push([f.sec, f.par, r[2], f.trecho, motivo, q]);
  }
  for (const r of data.ia) {
    const f = fixRow(String(r[0]), r[1], String(r[3] ?? ""), true);
    out.ia.push([f.sec, f.par, r[2], f.trecho]);
  }
  out.dg = data.dg.map((d) => [canon(order, d[0]), d[1]]);
  return { data: out, fixed, flagged };
}

// ---------- apresentação ----------
export type Row = { sec: string; par: number; sev: SevKey; tipo: "Português" | "Conteúdo"; trecho: string; txt: string };

export function rowsOf(L: Leitura, order: string[]): { rows: Row[]; verdict: Map<string, string> } {
  const rows: Row[] = [];
  const verdict = new Map<string, string>();
  for (const r of L.pt)
    rows.push({ sec: canon(order, r[0]), par: Number(r[1]) || 0, sev: sevOf(r[2]), tipo: "Português", trecho: String(r[3] ?? ""), txt: String(r[4] ?? "") });
  for (const sc of L.sc) {
    const sec = canon(order, sc.s);
    const v = String(sc.v ?? "").toUpperCase();
    if (v && (!verdict.has(sec) || v > (verdict.get(sec) ?? ""))) verdict.set(sec, v); // pior veredito entre trechos
    for (const p of Array.isArray(sc.p) ? sc.p : [])
      rows.push({ sec, par: Number(p[0]) || 0, sev: sevOf(p[1]), tipo: "Conteúdo", trecho: String(p[2] ?? ""), txt: String(p[3] ?? "") });
  }
  return { rows, verdict };
}

export const bySection = (order: string[], rows: Row[]) => {
  const secs = [...order, ...rows.map((r) => r.sec).filter((s) => !order.includes(s))];
  return [...new Set(secs)].map((sec) => ({
    sec,
    rows: rows.filter((r) => r.sec === sec).sort((a, b) => a.par - b.par || a.sev.localeCompare(b.sev)),
  }));
};

/** `link(sec, par)` permite que o vault do Obsidian transforme o ¶ em link para o parágrafo. */
export function table(rows: Row[], withTipo: boolean, link?: (sec: string, par: number) => string) {
  const head = withTipo
    ? "| ¶ | Sev. | Tipo | Trecho (marcar em vermelho) | O que corrigir |\n|---|---|---|---|---|"
    : "| ¶ | Sev. | Trecho | O que corrigir |\n|---|---|---|---|";
  const par = (r: Row) => (r.par ? (link ? link(r.sec, r.par) : String(r.par)) : "geral");
  const body = rows.map((r) =>
    withTipo
      ? `| ${par(r)} | ${SEV[r.sev]} | ${r.tipo} | ${cell(r.trecho)} | ${cell(r.txt)} |`
      : `| ${par(r)} | ${SEV[r.sev]} | ${cell(r.trecho)} | ${cell(r.txt)} |`,
  );
  return `${head}\n${body.join("\n")}`;
}

export const countLine = (rows: Row[]) =>
  (["A", "B", "C"] as SevKey[]).map((k) => `${SEV[k]} ${rows.filter((r) => r.sev === k).length}`).join("  ");

export function renderPortugues(saved: Saved) {
  const { rows } = rowsOf(saved.data, saved.order);
  const pt = rows.filter((r) => r.tipo === "Português");
  const L = ["# Revisão de português", "", `Achados: **${pt.length}** (${countLine(pt)})`, ""];
  for (const g of bySection(saved.order, pt)) L.push(`## ${g.sec}`, "", g.rows.length ? table(g.rows, false) : "Sem correções relevantes.", "");
  return L.join("\n");
}

export function renderSecoes(saved: Saved) {
  const { rows, verdict } = rowsOf(saved.data, saved.order);
  const ct = rows.filter((r) => r.tipo === "Conteúdo");
  const L = ["# Análise seção a seção", ""];
  for (const g of bySection(saved.order, ct)) {
    L.push(`### ${g.sec} — ${VERDICT[verdict.get(g.sec) ?? ""] ?? "—"}`, "", g.rows.length ? table(g.rows, false) : "Sem problemas relevantes.", "");
  }
  return L.join("\n");
}

const gq = (s: string) => encodeURIComponent(`"${s.replace(/["“”]/g, "").trim()}"`);

export function plagioItems(saved: Saved) {
  const rank: Record<string, number> = { A: 0, M: 1, B: 2 };
  return saved.data.pl
    .map((r) => ({
      sec: canon(saved.order, r[0]),
      par: Number(r[1]) || 0,
      risk: String(r[2] ?? "B").toUpperCase(),
      trecho: String(r[3] ?? ""),
      motivo: String(r[4] ?? ""),
      q: String(r[5] ?? ""),
    }))
    .sort((a, b) => (rank[a.risk] ?? 3) - (rank[b.risk] ?? 3));
}

export function renderPlagio(saved: Saved) {
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
