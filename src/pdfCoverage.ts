import type { NativeBlock, NativeRect } from "./pdfNativeModel";

export function covers(rect: NativeRect, target: NativeRect): boolean {
  const width = Math.min(rect.right, target.right) - Math.max(rect.left, target.left);
  const height = Math.min(rect.top, target.top) - Math.max(rect.bottom, target.bottom);
  return width > 0 && height > 0 &&
    width * height >= (target.right - target.left) * (target.top - target.bottom) * 0.65;
}

export function normalizedSource(text = ""): string {
  return text.normalize("NFKC").replace(/\u00AD/gu, "").replace(/\s+/gu, " ").trim();
}

export function joinPDFLines(lines: string[]): string {
  return normalizedSource(lines.map(line => line.trim()).join("\n")
    .replace(/(?<=\p{L}{5})[-\u2010]\n(?=[a-z]{2,5}(?:\s|[.,;:)]|$))/gu, "")
    .replace(/\n/gu, " "));
}

/** Process contiguous uncovered lines independently, preserving their actual page rectangles. */
export function uncoveredBlocks(block: NativeBlock, covered: NativeRect[]): NativeBlock[] {
  const rects = block.lineRects || [];
  const missing = rects.map(rect => !covered.some(placed => covers(placed, rect)));
  if (missing.every(Boolean)) return [{ ...block, text: block.lineTexts ? joinPDFLines(block.lineTexts) : block.text }];
  if (!block.lineTexts || block.lineTexts.length !== rects.length) return [];
  const fragments: NativeBlock[] = [];
  for (let start = 0; start < missing.length;) {
    if (!missing[start]) {
      start++;
      continue;
    }
    let end = start + 1;
    while (missing[end]) end++;
    const lineRects = rects.slice(start, end);
    fragments.push({
      ...block, id: block.id + ":fragment:" + start,
      text: joinPDFLines(block.lineTexts.slice(start, end)), lineRects,
      lineTexts: block.lineTexts.slice(start, end),
      bbox: {
        left: Math.min(...lineRects.map(rect => rect.left)),
        right: Math.max(...lineRects.map(rect => rect.right)),
        top: Math.max(...lineRects.map(rect => rect.top)),
        bottom: Math.min(...lineRects.map(rect => rect.bottom)),
      },
    });
    start = end;
  }
  return fragments;
}

export function isBodyText(block: NativeBlock, pageWidth: number): boolean {
  if (block.type !== "paragraph") return false;
  return /\p{L}/u.test(block.text) && (
    (block.lineRects?.length || 0) >= 2 && block.text.length >= 20 &&
      block.bbox.right - block.bbox.left >= pageWidth * 0.18 ||
    block.text.length >= 30 && block.text.split(/\s+/u).length >= 5 &&
      block.bbox.right - block.bbox.left >= pageWidth * 0.18
  );
}
