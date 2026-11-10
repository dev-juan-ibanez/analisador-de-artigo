/**
 * Extração determinística (sem IA) de citações no texto e referências,
 * com cruzamento e links para checagem manual.
 */

export type Reference = {
  id: number;
  raw: string;
  year: string | null;
  firstAuthor: string | null;
  doi: string | null;
  links: { doi?: string; scholar: string; crossref: string; openalex: string };
  citedCount: number;
};

export type InTextCitation = {
  raw: string;
  surname: string | null;
  year: string | null;
  numbers?: number[];
  matchedRef: number | null;
  context: string;
};

export type CitationReport = {
  style: "autor-data" | "numerico" | "indefinido";
  referencesFound: boolean;
  references: Reference[];
  citations: InTextCitation[];
  citedButMissing: InTextCitation[];
  listedButUncited: Reference[];
  warnings: string[];
};

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9' -]/g, "")
    .trim();

const REF_HEADING =
  /^(?:#{1,6}\s*)?\**\s*(?:\d+\.?\s*)?(refer[êe]ncias(?: bibliogr[áa]ficas)?|bibliografia|references|literatura citada)\s*\**\s*:?\s*$/i;
const AFTER_REFS_HEADING =
  /^#{1,6}\s*\**\s*(?:\d+\.?\s*)?(ap[êe]ndices?|anexos?|appendix|agradecimentos)\b/i;

export function splitBodyAndReferences(md: string) {
  const lines = md.split("\n");
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (REF_HEADING.test(lines[i].trim())) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return { body: md, refsBlock: "" };
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (AFTER_REFS_HEADING.test(lines[i].trim())) {
      end = i;
      break;
    }
  }
  return {
    body: lines.slice(0, idx).join("\n"),
    refsBlock: lines.slice(idx + 1, end).join("\n"),
  };
}

const NEW_ENTRY =
  /^(?:\[?\d{1,3}\]?[.)]?\s+|[A-ZÀ-Ý][\p{L}'’-]+(?:\s[\p{L}'’-]+)*,\s+[A-ZÀ-Ý]|[A-ZÀ-Ý][A-ZÀ-Ý'’ -]{2,},)/u;

export function splitReferenceEntries(block: string): string[] {
  // remove definições de notas de rodapé ([^1]: ...) que o pandoc coloca ao fim
  const cleaned = block
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => !/^\[\^[^\]]+\]:/.test(l.trim()))
    .join("\n")
    .trim();
  if (!cleaned) return [];
  const paras = cleaned
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\n/g, " ").replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean);
  if (paras.length >= 3) return paras;
  // Fallback: entradas coladas em linhas consecutivas
  const entries: string[] = [];
  for (const line of cleaned.split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (!entries.length || NEW_ENTRY.test(line)) entries.push(line);
    else entries[entries.length - 1] += " " + line;
  }
  return entries;
}

function parseReference(raw: string, id: number): Reference {
  // pandoc escapa pontuação ("1\. ", "\[s. l.\]"); remove escapes, negrito e numeração de lista
  const text = raw
    .replace(/\\([\\`*_{}\[\]()#+.!|>-])/g, "$1")
    .replace(/[*_]/g, "")
    .replace(/^\[?\d{1,3}\]?[.)]?\s+/, "")
    .trim();
  const year = /\b(?:19|20)\d{2}[a-z]?\b/.exec(text)?.[0] ?? null;
  const doiMatch = /10\.\d{4,9}\/[^\s"<>]+/i.exec(text);
  const doi = doiMatch ? doiMatch[0].replace(/[.,;)\]]+$/, "") : null;
  // Autor pessoal ("SILVA, J.") ou institucional ("BRASIL. Ministério…", "CANADIAN INSTITUTE FOR X. Título")
  let firstAuthor =
    /^([\p{L}'’ /&-]+?)(?:,|\.\s|\s+[A-Z]\.|\s+et al)/u.exec(text)?.[1]?.trim() ?? null;
  if (firstAuthor) {
    // Vancouver: "BROOKE J", "EZIQUIEL MF" → remove as iniciais finais
    const toks = firstAuthor.split(/\s+/);
    while (toks.length > 1 && /^[A-Z]{1,3}$/.test(toks[toks.length - 1])) toks.pop();
    firstAuthor = toks.join(" ");
  }
  const title =
    text
      .replace(/https?:\/\/\S+/g, "")
      .replace(/(?:doi:?\s*|https?:\/\/(?:dx\.)?doi\.org\/)?10\.\d{4,9}\/\S+/gi, "")
      .slice(0, 220)
      .trim() || text;
  const q = encodeURIComponent(title);
  return {
    id,
    raw: text,
    year,
    firstAuthor,
    doi,
    citedCount: 0,
    links: {
      doi: doi ? `https://doi.org/${doi}` : undefined,
      scholar: `https://scholar.google.com/scholar?q=${q}`,
      crossref: `https://search.crossref.org/search/works?q=${q}&from_ui=yes`,
      openalex: `https://openalex.org/works?search=${q}`,
    },
  };
}

const PARTICLE =
  "(?:(?:da|de|do|das|dos|di|del|van|von|der|la|le|DA|DE|DO|DAS|DOS|DI|DEL|VAN|VON|DER|LA|LE|Da|De|Do|Van|Von)\\s+)*";
const SURNAME = `${PARTICLE}[A-ZÀ-Ý][\\p{L}'’-]+`;
const INITIALS = "(?:\\s+[A-Z]{1,3}\\b)?"; // Vancouver: "Eziquiel MF"
const AUTH = `${SURNAME}${INITIALS}`;
// Outros autores: "; LASHKARI; GHORBANI", ", Lima", "e Souza", "et al.", ", et al."
const SURNAME_TAIL = `(?:\\s*[,;]\\s*${AUTH})*(?:\\s*,?\\s+et\\s+al\\.?|\\s+(?:e|and|&)\\s+${AUTH})?`;
const STOP_SURNAMES = new Set(
  "january february march april may june july august september october november december janeiro fevereiro marco março abril maio junho julho agosto setembro outubro novembro dezembro figura tabela quadro grafico gráfico fig tab secao seção capitulo capítulo versao versão".split(
    " ",
  ),
);
const LEAD_WORDS = /^(?:ver|cf\.?|vide|segundo|conforme|apud|see|e\.g\.,?|por exemplo,?)\s+/i;

function contextAround(text: string, index: number, len: number) {
  const s = Math.max(0, index - 90);
  const e = Math.min(text.length, index + len + 60);
  return text.slice(s, e).replace(/\s+/g, " ").trim();
}

function extractAuthorYear(body: string): InTextCitation[] {
  const out: InTextCitation[] = [];
  const seen = new Set<string>();
  const push = (c: InTextCitation, key: string) => {
    if (c.surname && STOP_SURNAMES.has(c.surname.toLowerCase())) return;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };

  // Parentética: (Silva, 2020; Lima e Souza, 2019a, p. 3)
  const parenRe = /\(([^()]*?\b(?:19|20)\d{2}[a-z]?[^()]*?)\)/g;
  const itemRe = new RegExp(
    `(${SURNAME})${INITIALS}${SURNAME_TAIL}[^0-9;]*?((?:19|20)\\d{2}[a-z]?)`,
    "gu",
  );
  for (const m of body.matchAll(parenRe)) {
    // No padrão ABNT o ";" separa tanto autores de uma obra quanto obras diferentes.
    // Partes sem ano pertencem à obra que termina na próxima parte com ano.
    let acc: string[] = [];
    for (const rawPart of m[1].split(";")) {
      const part = rawPart.trim().replace(LEAD_WORDS, "");
      if (!/\b(?:19|20)\d{2}[a-z]?\b/.test(part)) {
        acc.push(part);
        continue;
      }
      const merged = [...acc, part].join("; ");
      acc = [];
      itemRe.lastIndex = 0;
      const im = itemRe.exec(merged);
      if (!im) continue;
      push(
        {
          raw: `(${merged})`,
          surname: im[1],
          year: im[2],
          matchedRef: null,
          context: contextAround(body, m.index ?? 0, m[0].length),
        },
        `${norm(im[1])}|${im[2]}|${m.index}|${merged}`,
      );
    }
  }

  // Narrativa: Silva (2020), Silva e Lima (2020), Silva et al. (2020)
  const narrRe = new RegExp(`(${SURNAME})${INITIALS}${SURNAME_TAIL}\\s*\\(((?:19|20)\\d{2}[a-z]?)[^)]*\\)`, "gu");
  for (const m of body.matchAll(narrRe)) {
    push(
      {
        raw: m[0],
        surname: m[1],
        year: m[2],
        matchedRef: null,
        context: contextAround(body, m.index ?? 0, m[0].length),
      },
      `${norm(m[1])}|${m[2]}|n${m.index}`,
    );
  }
  return out;
}

function extractNumeric(body: string): InTextCitation[] {
  const out: InTextCitation[] = [];
  const re = /\[(\d{1,3}(?:\s*[-–,]\s*\d{1,3})*)\]/g;
  for (const m of body.matchAll(re)) {
    const nums = new Set<number>();
    for (const part of m[1].split(",")) {
      const range = part.split(/[-–]/).map((x) => parseInt(x.trim(), 10));
      if (range.length === 2 && range[1] >= range[0] && range[1] - range[0] < 50) {
        for (let n = range[0]; n <= range[1]; n++) nums.add(n);
      } else if (!Number.isNaN(range[0])) nums.add(range[0]);
    }
    out.push({
      raw: m[0],
      surname: null,
      year: null,
      numbers: [...nums],
      matchedRef: null,
      context: contextAround(body, m.index ?? 0, m[0].length),
    });
  }
  return out;
}

export function analyzeCitations(md: string): CitationReport {
  const warnings: string[] = [];
  const { body, refsBlock } = splitBodyAndReferences(md);
  const referencesFound = refsBlock.trim().length > 0;
  if (!referencesFound) {
    warnings.push(
      "Seção de referências não encontrada (procurei por cabeçalhos como 'Referências'/'References'). Verifique a conversão.",
    );
  }
  const references = splitReferenceEntries(refsBlock).map((r, i) => parseReference(r, i + 1));

  const authorYear = extractAuthorYear(body);
  const numeric = extractNumeric(body);
  const style: CitationReport["style"] =
    numeric.length > authorYear.length && numeric.length > 0
      ? "numerico"
      : authorYear.length > 0
        ? "autor-data"
        : "indefinido";
  const citations = style === "numerico" ? numeric : authorYear;

  const tok = (x: string) =>
    norm(x.replace(/[/&]/g, " "))
      .split(/\s+/)
      .filter(Boolean);
  // "SILVA" ~ "DA SILVA"; "ISO" ~ "ISO/ASTM"; "CANADIAN" ~ "CANADIAN INSTITUTE FOR CYBERSECURITY"
  const sameSurname = (a: string, b: string) => {
    const ta = tok(a);
    const tb = tok(b);
    if (!ta.length || !tb.length) return false;
    const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    const pre = short.every((t, i) => long[i] === t);
    const suf = short.every((t, i) => long[long.length - short.length + i] === t);
    return pre || suf;
  };
  for (const c of citations) {
    if (style === "numerico") {
      const ids = c.numbers ?? [];
      const valid = ids.filter((n) => references[n - 1]);
      valid.forEach((n) => references[n - 1].citedCount++);
      c.matchedRef = valid.length === ids.length && ids.length ? valid[0] : null;
    } else if (c.surname) {
      const y = c.year?.slice(0, 4);
      const cands = references.filter(
        (r) => sameSurname(r.firstAuthor ?? "", c.surname ?? "") && r.year?.startsWith(y ?? "~"),
      );
      // 2024a/2024b: se a citação traz a letra, prefere a referência com a mesma letra
      const hit = (c.year && /[a-z]$/.test(c.year) ? cands.find((r) => r.year === c.year) : undefined) ?? cands[0] ?? null;
      if (hit) {
        hit.citedCount++;
        c.matchedRef = hit.id;
      }
    }
  }

  // Coletivos como "Organização Mundial da Saúde" podem falhar no padrão; avisar
  if (style === "autor-data") {
    warnings.push(
      "Citações autor-data são detectadas por padrões (sobrenome + ano). Instituições como autor e citações incomuns podem gerar falsos 'ausentes' — confirme manualmente.",
    );
  }

  const citedButMissing = citations.filter((c) => c.matchedRef === null);
  const listedButUncited = references.filter((r) => r.citedCount === 0);
  return {
    style,
    referencesFound,
    references,
    citations,
    citedButMissing,
    listedButUncited,
    warnings,
  };
}

export function citationReportToMarkdown(r: CitationReport): string {
  const L: string[] = [];
  L.push("# Citações e referências (extração automática, sem IA)\n");
  L.push(`- Estilo detectado: **${r.style}**`);
  L.push(`- Citações no texto: **${r.citations.length}**`);
  L.push(`- Referências na lista: **${r.references.length}**`);
  L.push(`- Citadas no texto mas **ausentes da lista**: **${r.citedButMissing.length}**`);
  L.push(`- Na lista mas **nunca citadas**: **${r.listedButUncited.length}**\n`);
  for (const w of r.warnings) L.push(`> ⚠️ ${w}`);
  if (r.citedButMissing.length) {
    L.push("\n## Citadas no texto, ausentes da lista");
    for (const c of r.citedButMissing) L.push(`- ${c.raw} — «…${c.context}…»`);
  }
  if (r.listedButUncited.length) {
    L.push("\n## Na lista, nunca citadas no texto");
    for (const x of r.listedButUncited) L.push(`- [${x.id}] ${x.raw}`);
  }
  L.push("\n## Referências para checagem manual");
  for (const x of r.references) {
    L.push(
      `${x.id}. ${x.raw}\n   - ${x.doi ? `DOI: ${x.links.doi} · ` : "sem DOI · "}[Scholar](${x.links.scholar}) · [Crossref](${x.links.crossref}) · [OpenAlex](${x.links.openalex})`,
    );
  }
  return L.join("\n");
}
