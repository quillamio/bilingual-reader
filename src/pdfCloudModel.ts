import type { NativeBlock, NativeDocument, NativePage, NativeParser, NativeBlockType } from "./pdfNativeModel";

export type CloudParser = Extract<NativeParser, "mineru" | "mistral" | "llamaparse">;
export function isCloudParser(value: unknown): value is CloudParser {
  return value === "mineru" || value === "mistral" || value === "llamaparse";
}
export const CLOUD_NAMES = { mineru: "MinerU", mistral: "Mistral OCR", llamaparse: "LlamaParse" };

function pageBlock(page: NativePage, source: CloudParser, text: string,
  type: NativeBlockType, order: number): NativeBlock {
  // Markdown APIs do not provide reliable paragraph coordinates. Use an
  // explicit page-level rectangle, never invented fine-grained geometry.
  return { id: source + ":" + page.index + ":" + order, pageIndex: page.index,
    order, text, type, source,
    bbox: { left: 0, bottom: 0, right: page.width, top: page.height } };
}

function stripImageLinks(value: string): string {
  // Retain meaningful alt text, but never fetch remotely returned images.
  // Original artwork is kept by the PDF export engine instead.
  return value.replace(/!\[([^\]]*)\]\([^)\n]*\)/gu,
    (_match, alt: string) => /^(?:img|image|figure)?[-_.\d]*(?:\.(?:png|jpe?g|webp))?$/iu.test(alt.trim()) ? "" : alt)
    .replace(/<img\b[^>]*>/giu, "")
    .replace(/<br\s*\/?>/giu, "\n");
}
export function markdownBlocks(page: NativePage, source: CloudParser, markdown: string): NativeBlock[] {
  return stripImageLinks(markdown).split(/\n\s*\n/gu).flatMap((raw, order) => {
    const value = raw.trim();
    if (!value) return [];
    const type: NativeBlockType = /^#{1,6}\s/u.test(value) ? "heading"
      : /^(?:fig(?:ure)?\.?|图)\s*\d/iu.test(value) ? "caption"
      : /^\s*\||^<table\b/iu.test(value) ? "table" : "paragraph";
    return [pageBlock(page, source, value.replace(/^#{1,6}\s+/u, ""), type, order)];
  });
}
export function mergeCloudPages(base: NativeDocument, source: CloudParser,
  pages: Map<number, NativeBlock[]>): NativeDocument {
  if (!pages.size || ![...pages.values()].some(blocks => blocks.some(b => b.text.trim()))) {
    throw new Error(CLOUD_NAMES[source] + " 未返回可用的分页文本。");
  }
  const warnings = [...base.warnings];
  const output = base.pages.map(page => {
    const blocks = pages.get(page.index) || [];
    if (blocks.some(b => b.text.trim())) return { ...page, blocks };
    warnings.push(CLOUD_NAMES[source] + " 第 " + (page.index + 1) + " 页未返回文本；保留 PDF.js 原文。");
    return page;
  });
  return { source, pages: output, warnings };
}
export function normalizeMarkdownPages(base: NativeDocument,
  source: "mistral" | "llamaparse", rows: unknown): NativeDocument {
  if (!Array.isArray(rows) || rows.length > base.pages.length) {
    throw new Error("云端返回的页数异常。");
  }
  const map = new Map<number, NativeBlock[]>();
  for (const row of rows) {
    const index = source === "mistral" ? row?.index : row?.page_number - 1;
    if (!Number.isInteger(index) || index < 0 || index >= base.pages.length || map.has(index)) {
      throw new Error("云端页码无效或重复。");
    }
    const text = row?.success === false ? "" :
      [row?.header, row?.markdown, row?.footer].filter(v => typeof v === "string").join("\n\n");
    map.set(index, markdownBlocks(base.pages[index], source, text));
  }
  return mergeCloudPages(base, source, map);
}
/** Convert MinerU's top-left normalized page coordinates to PDF user space. */
function minerUTextRect(page: NativePage, raw: unknown) {
  if (!Array.isArray(raw) || raw.length !== 4 ||
      raw.some(value => typeof value !== "number" || !Number.isFinite(value) ||
        value < 0 || value > 1000)) return undefined;
  const [x0, y0, x1, y1] = raw as number[];
  if (x1 <= x0 || y1 <= y0) return undefined;

  const layout = page.layout || { width: page.width, height: page.height, transform: [1, 0, 0, -1, 0, page.height] };
  const [a, b, c, d, e, f] = layout.transform;
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || determinant === 0) return undefined;
  const point = (x: number, y: number) => {
    const vx = x * layout.width / 1000 - e, vy = y * layout.height / 1000 - f;
    return [(d * vx - c * vy) / determinant, (a * vy - b * vx) / determinant];
  };
  const first = point(x0, y0), last = point(x1, y1);
  const rect = { left: Math.min(first[0], last[0]), right: Math.max(first[0], last[0]),
    bottom: Math.min(first[1], last[1]), top: Math.max(first[1], last[1]) };
  return Object.values(rect).every(Number.isFinite) ? rect : undefined;
}

export function normalizeMinerU(base: NativeDocument, input: unknown): NativeDocument {
  // The v4 hosted API content_list V1 format has page_idx (zero-based)
  // and text/image/table fields. Prefer the documented V1 list over V2.
  if (!Array.isArray(input) || input.length > 500000) {
    throw new Error("MinerU 未返回可识别的 content_list V1 JSON。");
  }
  const map = new Map<number, NativeBlock[]>();
  for (const row of input) {
    const index = row?.page_idx;
    if (!Number.isInteger(index) || index < 0 || index >= base.pages.length) {
      throw new Error("MinerU 返回页码超出原始 PDF。");
    }
    const kind = String(row?.type || "");
    const strings = (v: unknown): string => typeof v === "string" ? v :
      Array.isArray(v) ? v.filter(x => typeof x === "string").join("\n") : "";
    let value = strings(row.text);
    let type: NativeBlockType = row.text_level ? "heading" : "paragraph";
    if (kind === "image") { type = "caption"; value = [strings(row.img_caption), strings(row.img_footnote)].filter(Boolean).join("\n"); }
    else if (kind === "table") { type = "table"; value = [strings(row.table_caption), strings(row.table_body), strings(row.table_footnote)].filter(Boolean).join("\n"); }
    else if (kind === "equation") { type = "formula"; value = strings(row.text); }
    if (!value.trim()) continue;
    const blocks = map.get(index) || [];
    const block = pageBlock(base.pages[index], "mineru", stripImageLinks(value), type, blocks.length);
    // Image and table bboxes describe the artwork itself, not its caption.
    const rect = kind === "text" ? minerUTextRect(base.pages[index], row.bbox) : undefined;
    if (rect) {
      block.bbox = rect;
      block.lineRects = [rect];
    }
    blocks.push(block);
    map.set(index, blocks);
  }
  return mergeCloudPages(base, "mineru", map);
}
