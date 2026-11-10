/**
 * Vault do Obsidian por artigo (data/jobs/<id>/vault): mapa navegável dos dados já calculados.
 * Gerado só pelo código (nenhum token). Cada seção vira uma nota; cada parágrafo tem âncora (^p3),
 * então as correções linkam direto para o parágrafo: [[Seções/02 INTRODUÇÃO#^p3|¶3]].
 */
import fs from "node:fs/promises";
import path from "node:path";
import { jobDir, readOptional, getJob } from "./jobs";
import { numberSections } from "./numbering";
import { RISK, SEV, VERDICT, bySection, canon, cell, countLine, plagioItems, rowsOf, table, type Saved } from "./leitura";

export const vaultDir = (id: string) => path.join(jobDir(id), "vault");

const safe = (t: string) =>
  t
    .replace(/[\\/:*?"<>|#^[\]]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "sem título";

const yaml = (o: Record<string, string | number | string[]>) =>
  "---\n" +
  Object.entries(o)
    .map(([k, v]) => (Array.isArray(v) ? `${k}: [${v.join(", ")}]` : typeof v === "number" ? `${k}: ${v}` : `${k}: "${String(v).replace(/"/g, "'")}"`))
    .join("\n") +
  "\n---\n";

export async function syncVault(id: string): Promise<void> {
  const job = await getJob(id);
  const md = await readOptional(id, "article.md");
  if (!job || !md) return;
  const dir = vaultDir(id);
  await fs.rm(path.join(dir, "Seções"), { recursive: true, force: true });
  await fs.mkdir(path.join(dir, "Seções"), { recursive: true });
  await fs.mkdir(path.join(dir, ".obsidian"), { recursive: true });
  await fs.writeFile(path.join(dir, ".obsidian", "app.json"), "{}");

  const sections = numberSections(md).filter((s) => s.paras.length);
  const names = new Map(sections.map((s, i) => [s.title, `${String(i + 1).padStart(2, "0")} ${safe(s.title)}`]));
  const noteOf = (title: string) => names.get(title) ?? safe(title);
  const link = (sec: string, par: number) => `[[Seções/${noteOf(sec)}#^p${par}\\|¶${par}]]`;

  const leitura = await readOptional(id, "leitura.json");
  const saved: Saved | null = leitura ? JSON.parse(leitura) : null;
  const order = sections.map((s) => s.title);
  const { rows, verdict } = saved ? rowsOf(saved.data, order) : { rows: [], verdict: new Map<string, string>() };
  const groups = bySection(order, rows);
  const digest = new Map((saved?.data.dg ?? []).map((d) => [canon(order, d[0]), String(d[1])]));
  const pl = saved ? plagioItems(saved) : [];

  // ---- uma nota por seção ----
  for (const [i, s] of sections.entries()) {
    const g = groups.find((x) => x.sec === s.title);
    const rs = g?.rows ?? [];
    const v = VERDICT[verdict.get(s.title) ?? ""] ?? "não analisada";
    const prev = sections[i - 1] && `[[Seções/${noteOf(sections[i - 1].title)}|← anterior]]`;
    const next = sections[i + 1] && `[[Seções/${noteOf(sections[i + 1].title)}|próxima →]]`;
    const ia = (saved?.data.ia ?? []).filter((r) => canon(order, r[0]) === s.title);
    const pls = pl.filter((p) => p.sec === s.title);
    const L = [
      yaml({
        tipo: "seção",
        artigo: job.filename,
        ordem: i + 1,
        parágrafos: s.paras.length,
        veredito: v,
        achados: rs.length,
        críticos: rs.filter((r) => r.sev === "A").length,
        tags: ["seção", v === "não analisada" ? "sem-análise" : "analisada"],
      }),
      `# ${s.title}`,
      `[[00 Mapa do artigo|↑ mapa]] · ${[prev, next].filter(Boolean).join(" · ")}`,
      "",
      `## Síntese`,
      digest.get(s.title) ?? "_(sem síntese)_",
      "",
      `## Correções (${countLine(rs)})`,
      rs.length ? table(rs, true, link) : "Sem correções nesta seção.",
      "",
    ];
    if (ia.length) L.push("## Sinais de IA", ...ia.map((r) => `- ${link(s.title, Number(r[1]))}: ${cell(r[2])} — “${cell(r[3])}”`), "");
    if (pls.length)
      L.push("## Possível plágio (pesquisar)", ...pls.map((p) => `- [${RISK[p.risk] ?? p.risk}] ${link(s.title, p.par)}: “${cell(p.trecho)}”`), "");
    L.push("## Texto");
    s.paras.forEach((p, k) => L.push(/\n/.test(p) ? `**¶${k + 1}**\n\n${p}\n^p${k + 1}\n` : `**¶${k + 1}** ${p} ^p${k + 1}\n`));
    await fs.writeFile(path.join(dir, "Seções", `${noteOf(s.title)}.md`), L.join("\n"));
  }

  // ---- notas das demais etapas (cópias com frontmatter e retorno ao mapa) ----
  const copies: [string, string, string][] = [
    ["Resumos.md", "resumos.md", "resumos"],
    ["Estrutura.md", "estrutura.md", "estrutura"],
    ["Avaliação geral.md", "geral.md", "avaliação"],
    ["Indícios de IA.md", "ia.md", "ia"],
    ["Plágio.md", "plagio.md", "plágio"],
    ["Citações.md", "citacoes.md", "citações"],
    ["Relatório.md", "relatorio.md", "relatório"],
  ];
  const present: string[] = [];
  for (const [note, file, tag] of copies) {
    const t = await readOptional(id, file);
    if (!t) continue;
    present.push(note.replace(/\.md$/, ""));
    await fs.writeFile(path.join(dir, note), `${yaml({ tipo: tag, artigo: job.filename, tags: [tag] })}[[00 Mapa do artigo|↑ mapa]]\n\n${t}`);
  }
  if (rows.length) {
    present.push("Correções");
    const body = groups
      .filter((g) => g.rows.length)
      .map((g) => `### [[Seções/${noteOf(g.sec)}|${g.sec}]] — ${VERDICT[verdict.get(g.sec) ?? ""] ?? "—"}\n\n${table(g.rows, true, link)}`)
      .join("\n\n");
    await fs.writeFile(
      path.join(dir, "Correções.md"),
      `${yaml({ tipo: "correções", artigo: job.filename, tags: ["correções"] })}[[00 Mapa do artigo|↑ mapa]]\n\n# Correções por seção e parágrafo\n\n${body}\n`,
    );
  }

  // ---- mapa ----
  const L = [
    yaml({ tipo: "mapa", artigo: job.filename, enviado: job.createdAt, seções: sections.length, achados: rows.length, tags: ["mapa"] }),
    `# Mapa — ${job.filename}`,
    "",
    "Abra a **visão de grafo** do Obsidian para ver as seções e as notas ligadas. Em cada correção, o número do parágrafo (¶) é um link que leva direto ao trecho.",
    "",
    "| # | Seção | Veredito | 🔴 | 🟠 | 🟡 | ¶ |",
    "|---|---|---|---|---|---|---|",
    ...sections.map((s, i) => {
      const rs = groups.find((x) => x.sec === s.title)?.rows ?? [];
      const n = (k: "A" | "B" | "C") => rs.filter((r) => r.sev === k).length;
      return `| ${i + 1} | [[Seções/${noteOf(s.title)}\\|${cell(s.title)}]] | ${VERDICT[verdict.get(s.title) ?? ""] ?? "—"} | ${n("A")} | ${n("B")} | ${n("C")} | ${s.paras.length} |`;
    }),
    "",
    `**Legenda:** ${SEV.A} crítico · ${SEV.B} importante · ${SEV.C} menor`,
    "",
    "## Outras notas",
    present.length ? present.map((n) => `- [[${n}]]`).join("\n") : "_(as notas das etapas aparecem conforme você avança)_",
    "",
  ];
  await fs.writeFile(path.join(dir, "00 Mapa do artigo.md"), L.join("\n"));
}
