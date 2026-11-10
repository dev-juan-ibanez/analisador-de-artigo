import { splitSections, type Section } from "./convert";
import { splitBodyAndReferences } from "./citations";

export type NumberedSection = Section & {
  /** Parágrafos (blocos separados por linha em branco), numerados a partir de 1 dentro da seção. */
  paras: string[];
  /** Entra nas análises por IA (tem texto; não é a lista de referências nem Resumo/Abstract/Resumen (etapa própria)). */
  analyzed: boolean;
};

/** Resumo/Abstract/Resumen têm etapa própria; ficam fora das demais análises. */
export const isAbstractTitle = (t: string) => /^(resumo|abstract|resumen)\b/i.test(t);
const isRefsTitle = (t: string) => /^(\d+\.?\s*)?(refer[êe]ncias|bibliografia|references)/i.test(t);

const toParas = (text: string) =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

/** Única fonte da numeração: usada pelos agentes e pela visão "Texto numerado". */
export function numberSections(md: string): NumberedSection[] {
  const { body } = splitBodyAndReferences(md);
  return splitSections(body).map((s) => ({
    ...s,
    paras: toParas(s.text),
    analyzed: s.text.length > 40 && !isRefsTitle(s.title) && !isAbstractTitle(s.title),
  }));
}

const BLOCK_START = /^(\||#|[-*+]\s|\d+[.)]\s|>|```|!\[)/;

/** Artigo em Markdown com marcadores **¶n** em cada parágrafo, por seção. */
export function numberedMarkdown(md: string): string {
  const { refsBlock } = splitBodyAndReferences(md);
  const out: string[] = [];
  for (const s of numberSections(md)) {
    if (s.level > 0) out.push(`${"#".repeat(Math.min(s.level, 6))} ${s.title}`);
    else out.push("*(Início do documento)*");
    s.paras.forEach((p, i) => {
      out.push(BLOCK_START.test(p) ? `**¶${i + 1}**\n\n${p}` : `**¶${i + 1}** ${p}`);
    });
  }
  if (refsBlock.trim()) out.push("## Referências", "*(sem numeração)*", refsBlock.trim());
  return out.join("\n\n") + "\n";
}
