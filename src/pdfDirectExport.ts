import { PDFDocument, rgb, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { prepareInPlacePage, type PageLayout, type PositionedPDFPage } from "./pdfInPlaceLayout";
import { wrapPDFText, requirePDFGlyphs } from "./pdfDirectText";
import { withPDFOperationDeadline } from "./pdfOperationDeadline";
import type { PDFExportTask } from "./pdfExportTask";

const FONT_URL = "chrome://bilingualreader/content/fonts/NotoSansSC-VF.ttf";
let cachedFont: Uint8Array | undefined;
async function loadBundledFont(task?: PDFExportTask): Promise<Uint8Array> {
  task?.throwIfCancelled();
  if (!cachedFont) {
    // A privileged, local chrome resource request must not go through any
    // network translation adapter (or depend on its mocked HTTP client).
    const xhr = new (Zotero.getMainWindow() as any).XMLHttpRequest() as XMLHttpRequest;
    const response = await withPDFOperationDeadline<ArrayBuffer>("内置中文字体读取", 30000, () => new Promise((resolve, reject) => {
      xhr.open("GET", FONT_URL, true);
      xhr.responseType = "arraybuffer";
      xhr.onload = () => {
        if ((xhr.status === 0 || xhr.status === 200) && xhr.response) resolve(xhr.response as ArrayBuffer);
        else reject(new Error("内置中文字体读取失败。"));
      };
      xhr.onerror = xhr.onabort = () => reject(new Error("内置中文字体读取失败。"));
      xhr.send();
    }), () => xhr.abort(), task);
    const bytes = new Uint8Array(response);
    if (bytes.length !== 17773132) throw new Error("内置中文字体缺失或不完整。");
    cachedFont = bytes;
  }
  return cachedFont;
}
type Paragraphs = PositionedPDFPage["paragraphs"];
export interface DirectRightPage { bytes?: Uint8Array; continuation?: Uint8Array; placed: number; remaining: Paragraphs }
function lineHeight(font: PDFFont, size: number): number {
  return Math.max(size * 1.22, font.heightAtSize(size) + 0.15);
}
function ascent(font: PDFFont, size: number): number {
  return font.heightAtSize(size, { descender: false });
}
async function saveChecked(pdf: PDFDocument, task?: PDFExportTask): Promise<Uint8Array> {
  task?.throwIfCancelled();
  const bytes = await pdf.save();
  task?.throwIfCancelled();
  if ((await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount() !== pdf.getPageCount()) {
    throw new Error("直接生成 PDF 页数校验失败。");
  }
  return bytes;
}
/** Create actual text objects; retain the masked original raster only as the right-side background. */
export async function buildDirectRightPage(
  doc: Document, pageIndex: number, paragraphs: Paragraphs,
  original?: { png: string; geometry: PageLayout }, task?: PDFExportTask,
): Promise<DirectRightPage> {
  const fontBytes = await loadBundledFont(task);
  const makeDoc = async () => {
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const font = await pdf.embedFont(fontBytes, { subset: true });
    return { pdf, font };
  };
  let bytes: Uint8Array | undefined;
  let continuation: Uint8Array | undefined;
  let placed = 0;
  let remaining = paragraphs;
  if (original) {
    const { pdf, font } = await makeDoc();
    const chars = new Set(font.getCharacterSet());
    for (const p of paragraphs) requirePDFGlyphs(p.text, chars);
    const { geometry, png } = original;
    const prepared = await prepareInPlacePage(doc, png, geometry, paragraphs, task, {
      width: (text, size) => font.widthOfTextAtSize(text, size),
      lineHeight: size => lineHeight(font, size),
    });
    if (prepared.placed) {
      const page = pdf.addPage([geometry.width, geometry.height]);
      page.drawImage(await pdf.embedPng(prepared.background), { x: 0, y: 0, width: geometry.width, height: geometry.height });
      for (const layer of prepared.layers) {
        task?.throwIfCancelled();
        for (const [index, line] of layer.lines.entries()) {
          page.drawText(line, { x: layer.box.x, y: geometry.height - layer.box.y - ascent(font, layer.size) - index * layer.lineHeight,
            font, size: layer.size, color: rgb(0.06, 0.06, 0.06) });
        }
      }
      bytes = await saveChecked(pdf, task);
      remaining = prepared.remaining;
      placed = prepared.placed;
    }
  }
  if (remaining.length) {
    const { pdf, font } = await makeDoc();
    const chars = new Set(font.getCharacterSet());
    const width = 595.28, height = 841.89, margin = 48;
    const label = "译文续页 · 原始第 " + (pageIndex + 1) + " 页";
    requirePDFGlyphs(label, chars);
    let page = pdf.addPage([width, height]);
    let y = height - margin;
    function header() {
      page.drawText(label, { x: margin, y: y - ascent(font, 9), font, size: 9, color: rgb(0.4, 0.4, 0.4) });
      y -= lineHeight(font, 9) + 14;
    }
    header();
    for (const paragraph of remaining) {
      task?.throwIfCancelled();
      requirePDFGlyphs(paragraph.text, chars);
      const size = paragraph.heading ? 12 : 11;
      const step = Math.max(lineHeight(font, size), size * 1.48);
      const lines = wrapPDFText(paragraph.text, width - 2 * margin - 0.5, text => font.widthOfTextAtSize(text, size));
      for (const line of lines) {
        task?.throwIfCancelled();
        if (y - step < margin) {
          if (pdf.getPageCount() >= 200) throw new Error("单页续页数量超过安全限制。");
          page = pdf.addPage([width, height]); y = height - margin; header();
        }
        if (line) page.drawText(line, { x: margin, y: y - ascent(font, size), font, size, color: rgb(0.08, 0.08, 0.08) });
        y -= step;
      }
      y -= 8;
    }
    continuation = await saveChecked(pdf, task);
  }
  return { bytes, continuation, placed, remaining };
}
