/** Conservative scientific-token preservation for English-to-Chinese translation. */
export type ScientificSpan = { start: number; end: number; text: string };
const TERMS = "FBN1|NOTCH2NLC|SMCHD1|DNMT3B|DUX4|DYSF|TP53|BRCA1|BRCA2|APOE|EGFR|KRAS|BRAF|PTEN|ACTB|GAPDH|SFTPC|AGER|CHRNA7|IL-6|TNF-α|NF-κB|C5b-9|mTOR|p53|iPSC|iPSCs|sgRNA|mRNA|miRNA|RNA|DNA|cDNA|PCR|qPCR|RT-PCR|CRISPR|Cas9|AAV9|NSAD|6MWT|10MRT|MMT|MRI|CT|ROC|AUC|HR|aHR|OR|RR|CI|SD|IQR|BMI|LDL-C|HDL-C|HbA1c|CRP|hs-CRP|eGFR|XunZi|FSHD|NIID|DMD|COPD|CVD|MFS|NIID-iPSC|ECU|ELISA|CHARLS|RCII|CoxPH|TGF-β|IFN-γ|IL-1β|CD4|CD8|CD20|ATP|NADH|IgG|IgM|IgA|SNP|GWAS|RNA-seq";
const NUMBER = "[+−-]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?(?:[eE][+−-]?\\d+)?|[+−-]?\\.\\d+";
const UNIT = "(?:%|‰|°C|°F|mmHg|mg/dL|g/dL|mmol/L|μmol/L|µmol/L|ng/mL|pg/mL|mg/kg|mL/min|kg/m²|kg/m2|mg|μg|µg|ng|pg|kg|mL|μL|µL|mm|cm|μm|µm|nm|km|ms|Hz|kDa|bp|kb|Mb|mM|μM|µM|nM|pM|s|m|h|L|g)";
const EDGE_LEFT = "(?<![A-Za-z0-9_])";
const EDGE_RIGHT = "(?![A-Za-z0-9_])";
const PATTERNS = [
  /\\\([^\n]{1,300}?\\\)|\\\[[^\n]{1,300}?\\\]|\$(?=[^$\n]{1,200}\$)(?=[^$\n]*[=^_\\])[^$\n]+\$/gu,
  /https?:\/\/[^\s<>\[\]{}"“”]+/gu,
  /\b10\.\d{4,9}\/[A-Za-z0-9._;()/:-]+/gu,
  /\[(?:\s*\d+(?:\s*[-–−]\s*\d+)?\s*[,;，]?)+\]/gu,
  /\([A-Z][A-Za-z'-]+(?:\s+et\s+al\.|\s*&\s*[A-Z][A-Za-z'-]+),?\s+\d{4}[a-z]?\)/gu,
  /(?<![A-Za-z0-9_])(?:[cgnmpr]\.\d+(?:[+−-]\d+)?[ACGT]>[ACGT]|p\.[A-Z][a-z]{2}\d+[A-Z][a-z]{2}|rs\d+|HLA-[A-Z]+\*\d+(?::\d+)+)(?![A-Za-z0-9_])/gu,
  new RegExp(EDGE_LEFT + "(?:(?:[PpNn]|HR|aHR|OR|RR|[rR]²|[rR]2|[rR]|[α-ωΑ-Ω])\\s*(?:<=|>=|[=<>≤≥≈])\\s*(?:" + NUMBER + "))" + EDGE_RIGHT, "gu"),
  new RegExp(EDGE_LEFT + "(?:" + TERMS + ")" + EDGE_RIGHT, "gu"),
  /(?<![A-Za-z0-9_])[A-Z][A-Z0-9-]{1,11}\d[A-Z0-9-]*(?![A-Za-z0-9_])/gu,
  new RegExp(EDGE_LEFT + "(?:" + NUMBER + ")(?:\\s*[-–−]\\s*(?:" + NUMBER + "))?(?:\\s?" + UNIT + ")?(?![A-Za-z0-9_]|\\.\\d)", "gu"),
  /[α-ωΑ-Ω]+(?:[-–][A-Za-z0-9]+)?/gu,
];
function tidySpan(value: string): string { return value.replace(/[.,;:!?。；，]+$/u, ""); }
export function scientificSpans(text: string): ScientificSpan[] {
  const spans: ScientificSpan[] = [];
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      const value = tidySpan(match[0]);
      const end = start + value.length;
      if (!value || spans.some(span => start < span.end && end > span.start)) continue;
      spans.push({ start, end, text: value });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}
function withoutSpans(text: string, spans = scientificSpans(text)): string {
  let result = "", cursor = 0;
  for (const span of spans) { result += text.slice(cursor, span.start) + " "; cursor = span.end; }
  return result + text.slice(cursor);
}
function formulaOnly(text: string): boolean {
  // A whole formula with a short variable lhs, no sentence words on the rhs.
  return /^[A-Za-zα-ωΑ-Ω](?:[₀-₉0-9])?\s*[=<>≤≥≈]\s*[A-Za-z0-9α-ωΑ-Ω\s+−\-*/×÷^²³⁰¹⁴-⁹₀-₉().,=<>≤≥√∑∫]+$/u.test(text.trim()) &&
    !/[A-Za-z]{3,}/u.test(text.trim());
}
export function isScientificPreserveOnly(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (formulaOnly(value)) return true;
  const residual = withoutSpans(value);
  // Do not classify normal headings, drug names or prose as protected identifiers.
  return !/\p{L}/u.test(residual) && (/\d|[α-ωΑ-Ω]|[=+−×÷∑∫√]/u.test(value) || scientificSpans(value).length > 0);
}
function comparable(text: string): string { return text.normalize("NFC").replace(/\s+/gu, "").replace(/−/gu, "-").replace(/µ/gu, "μ"); }
export type TranslationQuality = "valid" | "preserved" | "service-error" | "untranslated" | "missing-scientific-token" | "unresolved-marker";
export function translationQuality(source: string, result: string): TranslationQuality {
  const value = result.trim();
  if (!value || /^(?:\[请求错误\]|HTTP\s+[45]\d\d\b|此翻译服务不可用|翻译失败[：:]|(?:request|service|parse) error\s*:)/iu.test(value) || /HTTP\s+(?:GET|POST)[^\n]*failed with status code/iu.test(value)) return "service-error";
  if (/\[\[\s*BRSCI\d*[_\s-]/iu.test(value)) return "unresolved-marker";
  if (isScientificPreserveOnly(source) && comparable(source) === comparable(value)) return "preserved";
  const sourceWords = withoutSpans(source).match(/[A-Za-z]{2,}/gu) || [];
  if (sourceWords.length && (!/\p{Script=Han}/u.test(value) || comparable(source) === comparable(value))) return "untranslated";
  const counts = new Map<string, number>();
  for (const span of scientificSpans(source)) {
    const key = comparable(span.text);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const span of scientificSpans(value)) {
    const key = comparable(span.text);
    if (counts.has(key)) counts.set(key, counts.get(key)! - 1);
  }
  if ([...counts.values()].some(count => count > 0)) return "missing-scientific-token";
  if (isScientificPreserveOnly(source)) return "missing-scientific-token";
  const remainingWords = withoutSpans(value).match(/[A-Za-z]{2,}/gu) || [];
  const han = value.match(/\p{Script=Han}/gu)?.length || 0;
  if (sourceWords.length >= 8 && han < 3 && remainingWords.length >= sourceWords.length / 2) return "untranslated";
  return "valid";
}
export function validScientificTranslation(source: string, result: string): boolean {
  const quality = translationQuality(source, result);
  return quality === "valid" || quality === "preserved";
}
/** Use placeholders only as a recovery path; literal preservation is validated first. */
export function protectScientificText(source: string): { text: string; restore: (value: string) => string | undefined } {
  const spans = scientificSpans(source);
  let prefix = "BRSCI";
  while (source.includes(prefix)) prefix += "0";
  const markers = spans.map((span, i) => ({ ...span, marker: `[[${prefix}_${String(i).padStart(4, "0")}]]` }));
  let text = "", cursor = 0;
  for (const span of markers) { text += source.slice(cursor, span.start) + span.marker; cursor = span.end; }
  text += source.slice(cursor);
  return { text, restore(value: string) {
    let output = value;
    for (const span of markers) {
      if (output.split(span.marker).length !== 2) return undefined;
      output = output.replace(span.marker, () => span.text);
    }
    return output.includes(`[[${prefix}_`) ? undefined : output;
  } };
}
/** Split only outside protected spans; never insert spaces inside decimals, identifiers or citations. */
export function splitScientificText(text: string, maxChars: number): string[] {
  const source = text.trim();
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error("无效的翻译字符上限。");
  if (source.length <= maxChars) return [source];
  const spans = scientificSpans(source);
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    let end = Math.min(cursor + maxChars, source.length);
    if (end < source.length) {
      const crossing = spans.find(span => span.start < end && span.end > end);
      if (crossing) end = crossing.start;
      if (end <= cursor) throw new Error("单个科学标识超过翻译字符上限，请提高字符限制。");
      // Prefer whitespace after a sentence or word, not punctuation within a number.
      const candidate = source.slice(cursor, end);
      for (let i = candidate.length - 1; i >= Math.floor(candidate.length * 0.55); i--) {
        if (/\s/u.test(candidate[i]) && !spans.some(span => span.start < cursor + i && span.end > cursor + i)) { end = cursor + i; break; }
      }
      if (end <= cursor) end = Math.min(cursor + maxChars, source.length);
      // Do not split surrogate pairs.
      if (/[\uD800-\uDBFF]/u.test(source[end - 1]) && end < source.length) end--;
      if (end <= cursor) throw new Error("无法在字符上限内安全分段。");
    }
    const chunk = source.slice(cursor, end).trim();
    if (chunk) chunks.push(chunk);
    cursor = end;
    while (/\s/u.test(source[cursor] || "")) cursor++;
  }
  return chunks;
}

export interface ScientificResponse { text: string; engineTag: string; }
export type ScientificRequest = (text: string, accept: (result: string) => string | undefined) => Promise<ScientificResponse>;
/** Validate raw output first. Only a detected token-loss failure warrants a masked retry. */
export async function translateScientificRequest(
  source: string, request: ScientificRequest, maxChars: number, isCancelled?: () => boolean,
): Promise<ScientificResponse> {
  if (isCancelled?.()) throw new Error("翻译任务已取消。");
  if (isScientificPreserveOnly(source)) return { text: source.trim(), engineTag: "scientific:preserved" };
  let needsRecovery = false;
  try {
    return await request(source, result => {
      const quality = translationQuality(source, result);
      if (quality === "missing-scientific-token") needsRecovery = true;
      return quality === "valid" ? result : undefined;
    });
  } catch (error) {
    // No masked retries on plain network failures, cancellation or quota exhaustion.
    if (isCancelled?.() || !needsRecovery) throw error;
    const protectedText = protectScientificText(source);
    if (protectedText.text === source || protectedText.text.length > maxChars) throw error;
    return request(protectedText.text, result => {
      const restored = protectedText.restore(result);
      return restored !== undefined && validScientificTranslation(source, restored) ? restored : undefined;
    });
  }
}
