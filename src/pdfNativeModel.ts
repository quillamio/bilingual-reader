/**
 * Reading-mode-independent, structured PDF page model.
 *
 * PDF.js supplies text geometry and whole-page renderings; Docling can replace
 * heuristically recovered reading order without affecting the source pages.
 * This module does not access Zotero's SDT structure or #sdt-content.
 */
export type NativeParser = "pdfjs" | "docling" | "mineru" | "mistral" | "llamaparse";
export type NativeBlockType =
  | "heading" | "paragraph" | "caption" | "table"
  | "picture" | "formula" | "footnote";

export interface NativeRect {
  left: number;
  bottom: number;
  right: number;
  top: number;
}
export interface NativeBlock {
  id: string;
  pageIndex: number;
  order: number;
  type: NativeBlockType;
  text: string;
  bbox: NativeRect;
  source: NativeParser;
}
export interface NativePage {
  index: number;
  width: number;
  height: number;
  blocks: NativeBlock[];
}
export interface NativeDocument {
  source: NativeParser;
  pages: NativePage[];
  warnings: string[];
}
export const PDF_PARSER_NAMES: Record<NativeParser, string> = {
  pdfjs: "PDF.js",
  docling: "Docling",
  mineru: "MinerU",
  mistral: "Mistral OCR",
  llamaparse: "LlamaParse",
};

export function describePDFParser(document: NativeDocument, selected: NativeParser): string {
  const actual = PDF_PARSER_NAMES[document.source];
  if (selected !== document.source) return `解析：${PDF_PARSER_NAMES[selected]} → ${actual}（已回退）`;
  if (selected === "pdfjs") return "解析：PDF.js";
  const fallback = document.pages.filter((page) => page.blocks.some((block) => block.source === "pdfjs")).length;
  return `解析：${actual}` + (fallback ? ` · ${fallback} 页使用 PDF.js 补位` : "");
}

export interface PDFJSTextItem {
  str: string;
  transform: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
}

interface Line {
  x1: number;
  x2: number;
  y: number;
  height: number;
  text: string;
}
function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}
function quantileMedian(values: number[], fallback: number): number {
  if (!values.length) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
function rectOf(line: Line): NativeRect {
  return { left: line.x1, right: line.x2, bottom: line.y - line.height * 0.2, top: line.y + line.height * 0.8 };
}
function combineRect(a: NativeRect, b: NativeRect): NativeRect {
  return {
    left: Math.min(a.left, b.left),
    bottom: Math.min(a.bottom, b.bottom),
    right: Math.max(a.right, b.right),
    top: Math.max(a.top, b.top),
  };
}
function labelBlock(text: string): NativeBlockType {
  if (/^(?:extended data )?(?:fig(?:ure)?\.?|图)\s*[\dIVX]/iu.test(text)) return "caption";
  if (/^table\s*[\dIVX]|^表\s*\d/iu.test(text)) return "caption";
  if (/^\d+(?:\.\d+){0,3}\s+[A-Z]/u.test(text) && text.length < 110) return "heading";
  return "paragraph";
}
export function pdfjsTextToLines(items: readonly PDFJSTextItem[], width: number): Line[] {
  const elements = items.flatMap((item) => {
    const str = String(item?.str || "");
    if (!str.trim() || !Array.isArray(item?.transform) ||
        item.transform.length < 6 || !finite(item.transform[4]) ||
        !finite(item.transform[5])) return [];
    const x = item.transform[4];
    const y = item.transform[5];
    const h = Math.max(5, Number(item.height) || Math.hypot(item.transform[0], item.transform[1]) || 9);
    const w = Math.max(1, Number(item.width) || str.length * h * 0.5);
    // Exclude objects far outside the PDF page; these are usually decorative.
    if (x < -width || x > width * 2) return [];
    return [{ text: str, x, y, h, w, eol: !!item.hasEOL }];
  });
  const baselineTolerance = Math.max(2.1, Math.min(6, quantileMedian(elements.map((e) => e.h), 10) * 0.26));
  // PDF.js text items can arrive in content-stream order, not display order.
  elements.sort((a, b) => b.y - a.y || a.x - b.x);
  const bands: typeof elements[] = [];
  for (const el of elements) {
    const last = bands[bands.length - 1];
    if (last?.length && Math.abs(last[0].y - el.y) < baselineTolerance) last.push(el);
    else bands.push([el]);
  }
  const lines: Line[] = [];
  for (const band of bands) {
    band.sort((a, b) => a.x - b.x);
    let pending: typeof band = [];
    const flush = () => {
      if (!pending.length) return;
      const first = pending[0];
      const last = pending[pending.length - 1];
      let joined = "";
      let lastEnd = first.x;
      for (const run of pending) {
        const gap = run.x - lastEnd;
        const charWidth = Math.max(2, run.w / Math.max(1, run.text.trim().length));
        if (joined && gap > charWidth * 0.55 && !/\s$/u.test(joined) &&
            !/^\s/u.test(run.text)) joined += " ";
        joined += run.text;
        lastEnd = Math.max(lastEnd, run.x + run.w);
      }
      lines.push({
        x1: first.x,
        x2: Math.max(...pending.map((run) => run.x + run.w)),
        y: first.y,
        height: Math.max(...pending.map((run) => run.h)),
        text: joined.replace(/[ \t]+/gu, " ").trim(),
      });
      pending = [];
    };
    for (const run of band) {
      const prior = pending[pending.length - 1];
      // Separate two-column lines sharing the same baseline.
      if (prior && run.x - (prior.x + prior.w) > Math.max(34, width * 0.075)) flush();
      pending.push(run);
      if (run.eol) flush();
    }
    flush();
  }
  return lines.filter((line) => line.text);
}

/** Read column by column, but preserve wide section headings/captions. */
export function orderPDFJSLines(lines: readonly Line[], pageWidth: number): Line[] {
  if (lines.length < 5) return [...lines].sort((a, b) => b.y - a.y || a.x1 - b.x1);
  const medianLineWidth = quantileMedian(lines.map((l) => l.x2 - l.x1), pageWidth * 0.7);
  const left = lines.filter((l) => l.x1 < pageWidth * 0.47 && l.x2 < pageWidth * 0.59);
  const right = lines.filter((l) => l.x1 > pageWidth * 0.48 && l.x2 > pageWidth * 0.62);
  const twoColumns = medianLineWidth < pageWidth * 0.59 &&
    left.length >= 3 && right.length >= 3;
  if (!twoColumns) return [...lines].sort((a, b) => b.y - a.y || a.x1 - b.x1);
  const full = lines.filter((l) => l.x1 < pageWidth * 0.44 && l.x2 > pageWidth * 0.58);
  const remaining = lines.filter((l) => !full.includes(l));
  const ordered: Line[] = [];
  // Wide headings separate independent zones; avoid reading two columns
  // together at every horizontal y-band.
  const headings = [...full].sort((a, b) => b.y - a.y);
  const boundaries = [Infinity, ...headings.map((h) => h.y), -Infinity];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const upper = boundaries[i], lower = boundaries[i + 1];
    const part = remaining.filter((l) => l.y < upper && l.y > lower);
    const leftPart = part.filter((l) => (l.x1 + l.x2) / 2 < pageWidth / 2.0);
    const rightPart = part.filter((l) => !leftPart.includes(l));
    ordered.push(...leftPart.sort((a, b) => b.y - a.y));
    ordered.push(...rightPart.sort((a, b) => b.y - a.y));
    if (i < headings.length) ordered.push(headings[i]);
  }
  return ordered;
}
export function extractPDFJSPage(
  index: number,
  width: number,
  height: number,
  items: readonly PDFJSTextItem[],
): NativePage {
  const ordered = orderPDFJSLines(pdfjsTextToLines(items, width), width);
  const heights = ordered.map((line) => line.height);
  const typicalHeight = quantileMedian(heights, 10);
  const blocks: NativeBlock[] = [];
  let current: Line[] = [];
  const flush = () => {
    if (!current.length) return;
    const text = current.map((line) => line.text)
      .join(" ").replace(/\s+/gu, " ").trim();
    if (text) {
      const bbox = current.map(rectOf).reduce(combineRect);
      blocks.push({ id: "pdfjs:" + index + ":" + blocks.length, pageIndex: index,
        order: blocks.length, type: labelBlock(text), text, bbox, source: "pdfjs" });
    }
    current = [];
  };
  for (const line of ordered) {
    if (current.length) {
      const prev = current[current.length - 1];
      const gap = prev.y - line.y;
      const horizontalJump = Math.abs(prev.x1 - line.x1) > Math.max(45, width * 0.18);
      const paragraphBreak = gap < -3 || gap > typicalHeight * 1.85 ||
        horizontalJump || labelBlock(line.text) !== "paragraph";
      if (paragraphBreak) flush();
    }
    current.push(line);
    if (labelBlock(line.text) !== "paragraph") flush();
  }
  flush();
  return { index, width, height, blocks };
}
export function validateNativeDocument(input: unknown, source: "pdfjs" | "docling"): NativeDocument {
  const data = input as any;
  if (!Array.isArray(data?.pages) || data.pages.length > 10000 ||
      data.pages.some((p: any) => !finite(p?.width) || !finite(p?.height) ||
        p.width <= 0 || p.height <= 0 || !Number.isInteger(p.index) || p.index < 0)) {
    throw new Error("文档解析服务返回了无效的页面结构。");
  }
  const pages: NativePage[] = data.pages.map((page: any) => ({
    index: page.index, width: page.width, height: page.height,
    blocks: (Array.isArray(page.blocks) ? page.blocks : []).slice(0, 100000)
      .filter((block: any) => block && typeof block.text === "string" &&
        typeof block.type === "string" && block.text.length < 200000)
      .map((block: any, order: number) => ({
        id: String(block.id || source + ":" + page.index + ":" + order),
        pageIndex: page.index, order,
        type: (["heading", "paragraph", "caption", "table", "picture",
          "formula", "footnote"].includes(block.type) ? block.type : "paragraph") as NativeBlockType,
        text: block.text, source, bbox: block.bbox || {
          left: 0, bottom: 0, right: page.width, top: page.height,
        },
      })),
  }));
  return { source, pages,
    warnings: Array.isArray(data.warnings) ? data.warnings.filter(
      (v: unknown): v is string => typeof v === "string").slice(0, 100) : [] };
}
