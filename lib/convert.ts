import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

export const SUPPORTED_EXTENSIONS = [".docx", ".doc", ".pdf", ".odt", ".rtf"];

async function findSoffice(): Promise<string | null> {
  const candidates = [
    "soffice",
    "libreoffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  ];
  for (const c of candidates) {
    try {
      await exec(c, ["--version"], { timeout: 20000 });
      return c;
    } catch {}
  }
  return null;
}

async function viaPandoc(input: string, from?: string) {
  const args = [input, "-t", "gfm", "--wrap=none"];
  if (from) args.push("-f", from);
  const { stdout } = await exec("pandoc", args, { maxBuffer: MAX_BUFFER });
  return stdout;
}

const HEADING_WORDS =
  "resumo|abstract|resumen|palavras[- ]chave|keywords|introdu[çc][ãa]o|referencial te[óo]rico|fundamenta[çc][ãa]o te[óo]rica|revis[ãa]o (?:da )?literatura|metodologia|m[ée]todos?|materiais e m[ée]todos|resultados(?: e discuss[ãa]o)?|discuss[ãa]o|considera[çc][õo]es finais|conclus[ãa]o|conclus[õo]es|agradecimentos|refer[êe]ncias(?: bibliogr[áa]ficas)?|ap[êe]ndices?|anexos?";

/** Reflui o texto do pdftotext: junta linhas de parágrafo, remove hifenização e promove títulos. */
export function reflowPdfText(raw: string): string {
  const text = raw.replace(/\r/g, "").replace(/\f/g, "\n\n");
  const lines = text.split("\n");
  const out: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.trim()) out.push(buf.trim());
    buf = "";
  };
  const headingRe = new RegExp(
    `^(?:\\d+(?:\\.\\d+)*\\.?\\s+)?(?:${HEADING_WORDS})\\s*:?$`,
    "i",
  );
  const numberedRe = /^\d+(?:\.\d+)*\.?\s+[A-ZÀ-Ý][^.!?]{2,90}$/;
  for (const l of lines) {
    const line = l.trim();
    if (!line) {
      flush();
      continue;
    }
    if (headingRe.test(line) || (numberedRe.test(line) && line.length < 90)) {
      flush();
      const depth = /^\d+\.\d+/.test(line) ? "###" : "##";
      out.push(`${depth} ${line}`);
      continue;
    }
    if (buf.endsWith("-") && /^[a-zà-ÿ]/.test(line)) buf = buf.slice(0, -1) + line;
    else buf += (buf ? " " : "") + line;
  }
  flush();
  return out.join("\n\n");
}

const capitalize = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

/**
 * Muitos .docx não usam estilos de título: os títulos chegam como parágrafos só em negrito
 * (`**1 INTRODUÇÃO**`). Promove esses parágrafos a cabeçalhos Markdown. Idempotente.
 */
export function promoteHeadings(md: string): string {
  const known = new RegExp(`^(?:${HEADING_WORDS})$`, "i");
  let firstSeen = false;
  return md
    .split("\n")
    .map((line) => {
      // "**RESUMO:** texto..." → título "Resumo" + parágrafo
      const lab = /^\*\*\s*(RESUMO|ABSTRACT|RESUMEN)\s*:?\s*\*\*\s*:?\s*(.+)$/i.exec(line);
      if (lab) return `## ${capitalize(lab[1])}\n\n${lab[2]}`;

      const m = /^\*\*\s*(.+?)\s*\*\*\s*$/.exec(line);
      if (!m) {
        if (line.trim()) firstSeen = true;
        return line;
      }
      const text = m[1].replace(/\s*:\s*$/, "").trim();
      const isFirst = !firstSeen;
      firstSeen = true;
      if (!text || text.length > 140) return line;
      const num = /^(\d+(?:\.\d+)*)\.?\s+\S/.exec(text);
      if (num) {
        const dots = (num[1].match(/\./g) ?? []).length;
        return `${"#".repeat(Math.min(2 + dots, 5))} ${text}`;
      }
      if (known.test(text)) return `## ${text}`;
      // primeira linha em negrito e toda em maiúsculas = título do artigo
      if (isFirst && text === text.toUpperCase() && /[A-ZÀ-Ý]/.test(text)) return `# ${text}`;
      return line;
    })
    .join("\n");
}

export type Conversion = { markdown: string; notes: string[] };

export async function convertToMarkdown(
  inputPath: string,
  workDir: string,
): Promise<Conversion> {
  const r = await convertRaw(inputPath, workDir);
  return { ...r, markdown: promoteHeadings(r.markdown) };
}

async function convertRaw(
  inputPath: string,
  workDir: string,
): Promise<Conversion> {
  const ext = path.extname(inputPath).toLowerCase();
  const notes: string[] = [];
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new Error(`Formato não suportado: ${ext}`);
  }

  if (ext === ".pdf") {
    const { stdout } = await exec(
      "pdftotext",
      ["-enc", "UTF-8", "-nopgbrk", inputPath, "-"],
      { maxBuffer: MAX_BUFFER },
    );
    if (stdout.trim().length < 200) {
      throw new Error(
        "O PDF parece não ter texto selecionável (talvez seja escaneado). É necessário OCR.",
      );
    }
    notes.push(
      "PDF convertido com pdftotext: tabelas, colunas duplas e títulos podem estar imperfeitos.",
    );
    return { markdown: reflowPdfText(stdout), notes };
  }

  if (ext === ".docx") return { markdown: await viaPandoc(inputPath, "docx"), notes };
  if (ext === ".odt") return { markdown: await viaPandoc(inputPath, "odt"), notes };
  if (ext === ".rtf") return { markdown: await viaPandoc(inputPath, "rtf"), notes };

  // .doc → docx via LibreOffice → pandoc
  const soffice = await findSoffice();
  if (!soffice) {
    throw new Error(
      "Arquivos .doc exigem o LibreOffice (instale com: brew install --cask libreoffice) ou salve o arquivo como .docx.",
    );
  }
  await exec(
    soffice,
    ["--headless", "--convert-to", "docx", "--outdir", workDir, inputPath],
    { timeout: 120000 },
  );
  const converted = path.join(workDir, path.basename(inputPath, ext) + ".docx");
  await fs.access(converted);
  return { markdown: await viaPandoc(converted, "docx"), notes };
}

export type Section = { title: string; level: number; text: string };

/** Divide o markdown em seções por cabeçalhos (`#`). */
export function splitSections(md: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { title: "(Início / título)", level: 0, text: "" };
  for (const line of md.split("\n")) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m && m[2].replace(/[*_`]/g, "").trim()) {
      if (current.text.trim() || current.level > 0) sections.push(current);
      current = { title: m[2].replace(/[*_`]/g, "").trim(), level: m[1].length, text: "" };
    } else {
      current.text += line + "\n";
    }
  }
  if (current.text.trim() || current.level > 0) sections.push(current);
  return sections.map((s) => ({ ...s, text: s.text.trim() }));
}
