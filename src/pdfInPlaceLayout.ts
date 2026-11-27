import type { NativeRect } from "./pdfNativeModel";
import { PDF_DEADLINES, withPDFOperationDeadline } from "./pdfOperationDeadline";

export interface PositionedPDFPage {
  pageIndex: number;
  excludedRects?: NativeRect[];
  paragraphs: Array<{
    text: string; sourceText?: string; heading?: boolean; rects: NativeRect[];
  }>;
}

type Rect = { x: number; y: number; width: number; height: number };
type PageLayout = { transform: number[]; width: number; height: number };
const FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

function toPageRect(rect: NativeRect, page: PageLayout): Rect | undefined {
  const [a, b, c, d, e, f] = page.transform;
  const x1 = a * rect.left + c * rect.bottom + e;
  const y1 = b * rect.left + d * rect.bottom + f;
  const x2 = a * rect.right + c * rect.top + e;
  const y2 = b * rect.right + d * rect.top + f;
  const x = Math.max(0, Math.min(x1, x2));
  const y = Math.max(0, Math.min(y1, y2));
  const width = Math.min(page.width, Math.max(x1, x2)) - x;
  const height = Math.min(page.height, Math.max(y1, y2)) - y;
  if (width >= 3 && height >= 3) return { x, y, width, height };
  return undefined;
}

function bound(rects: Rect[]): Rect {
  const x = Math.min(...rects.map(rect => rect.x));
  const y = Math.min(...rects.map(rect => rect.y));
  return {
    x, y, width: Math.max(...rects.map(rect => rect.x + rect.width)) - x,
    height: Math.max(...rects.map(rect => rect.y + rect.height)) - y,
  };
}

function fitText(ctx: CanvasRenderingContext2D, text: string, box: Rect,
  initialSize: number, heading?: boolean) {
  const pieces = text.replace(/\s+/gu, " ").trim()
    .match(/[\p{Script=Han}，。；：、！？（）]|[^\s\p{Script=Han}，。；：、！？（）]+| /gu) || [];
  for (let size = Math.max(6, initialSize); size >= 6; size -= 0.5) {
    const lineHeight = size * 1.22;
    const lines: string[] = [];
    ctx.font = (heading ? "bold " : "") + size + "pt " + FONT;
    const width = (value: string) => ctx.measureText(value).width * 0.75;
    let line = "";
    for (const piece of pieces) {
      const tokens = width(piece) > box.width ? Array.from(piece) : [piece];
      for (const token of tokens) {
        if (line && width(line + token) > box.width - 0.3) {
          lines.push(line.trimEnd());
          line = "";
        }
        line += line ? token : token.trimStart();
      }
    }
    if (line) lines.push(line.trimEnd());
    if (lines.length && lines.length * lineHeight <= box.height + 0.5 &&
        lines.every(line => width(line) <= box.width)) return { size, lineHeight, lines };
  }
  return undefined;
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const pt = (n: number) => n.toFixed(3) + "pt";

/** Measure translations with Gecko's fonts and erase only the old text bands. */
export async function buildInPlacePageHTML(
  doc: Document, original: string, page: PageLayout, paragraphs: PositionedPDFPage["paragraphs"],
): Promise<{ html: string; remaining: PositionedPDFPage["paragraphs"]; placed: number }> {
  const canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas") as HTMLCanvasElement;
  const image = doc.createElementNS("http://www.w3.org/1999/xhtml", "img") as HTMLImageElement;
  image.src = original;
  await withPDFOperationDeadline("原位页面图像解码", PDF_DEADLINES.image,
    () => image.decode(), () => image.removeAttribute("src"));
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("无法绘制右侧 PDF 页面。");
  const sx = canvas.width / page.width, sy = canvas.height / page.height;
  ctx.drawImage(image, 0, 0);
  const layers: string[] = [];
  const occupied: Rect[] = [];
  const remaining = new Set(paragraphs);
  try {
    for (const paragraph of paragraphs) {
      const { text, heading, rects } = paragraph;
      const regions = rects.flatMap(rect => {
        const region = toPageRect(rect, page);
        return region ? [region] : [];
      });
      if (!regions.length || regions.length !== rects.length) continue;
      const box = bound(regions);
      // A paragraph glued across the gutter cannot be safely replaced as one.
      const middle = page.width / 2;
      if (regions.some(rect => rect.x + rect.width < middle) &&
          regions.some(rect => rect.x >= middle)) continue;
      // Never replace an area that already belongs to a different translation.
      if (occupied.some(other =>
        Math.min(box.x + box.width, other.x + other.width) - Math.max(box.x, other.x) > 2 &&
        Math.min(box.y + box.height, other.y + other.height) - Math.max(box.y, other.y) > 2)) continue;

      const fontHeight = Math.min(...regions.map(rect => rect.height));
      const fitted = fitText(ctx, text, box, Math.min(heading ? 28 : 12, fontHeight * 0.81), heading);
      if (!fitted) continue;

      // Require light backgrounds at both edges of each text band. This
      // protects text on dark figure artwork from destructive white masking.
      const light = regions.every(rect => {
        const y = Math.min(canvas.height - 1, Math.round((rect.y + rect.height / 2) * sy));
        const sample = (x: number) => ctx.getImageData(
          Math.min(canvas.width - 1, Math.max(0, Math.round(x * sx))), y, 1, 1,
        ).data;
        return [sample(rect.x - 0.8), sample(rect.x + rect.width + 0.8)]
          .every(p => p[0] > 220 && p[1] > 220 && p[2] > 220);
      });
      if (!light) continue;

      ctx.fillStyle = "#fff";
      for (const rect of regions) {
        ctx.fillRect((rect.x - 0.25) * sx, (rect.y - 0.15) * sy,
          (rect.width + 0.5) * sx, (rect.height + 0.3) * sy);
      }
      occupied.push(box);
      remaining.delete(paragraph);
      layers.push(`<div class="text" style="left:${pt(box.x)};top:${pt(box.y)};font-size:${pt(fitted.size)};line-height:${pt(fitted.lineHeight)};font-weight:${heading ? 700 : 400}">${fitted.lines.map(escape).join("<br>")}</div>`);
    }
    const background = canvas.toDataURL("image/png");
    if (!background.startsWith("data:image/png;base64,")) throw new Error("右侧 PDF 页面绘制失败。");
    return {
      placed: layers.length, remaining: [...remaining],
      html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>
@page { size:${pt(page.width)} ${pt(page.height)}; margin:0; }
html, body { margin:0; padding:0; }
img { position:absolute; top:0; left:0; width:${pt(page.width)}; height:${pt(page.height)}; }
.text { position:absolute; color:#101010; white-space:pre; font-family:${FONT}; }
</style></head><body><img alt="" src="${background}">${layers.join("")}</body></html>`,
    };
  } finally {
    canvas.width = canvas.height = 0;
  }
}
