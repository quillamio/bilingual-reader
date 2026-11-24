/**
 * Copy actual PDF pages instead of printing screenshots or relying on the
 * reading-mode DOM. Retains original page content, fonts, image XObjects and
 * vector artwork. Document-level bookmarks, forms and signatures are not
 * guaranteed to survive a new combined PDF; the source attachment is untouched.
 */
import type { PDFDocument, PDFPage } from "pdf-lib";

export async function combinePDFPages(
  original: Uint8Array, bilingual: Uint8Array, originalFirst = true,
  expectedOriginalPages?: number,
): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib");
  const source = await PDFDocument.load(original, { updateMetadata: false });
  const transcript = await PDFDocument.load(bilingual, { updateMetadata: false });
  const sourceCount = source.getPageCount();
  const transcriptCount = transcript.getPageCount();
  if (!sourceCount || !transcriptCount ||
      (expectedOriginalPages !== undefined && sourceCount !== expectedOriginalPages)) {
    throw new Error("原始 PDF 与译文页数校验失败，已取消导出。");
  }
  const output = await PDFDocument.create();
  for (const doc of originalFirst ? [source, transcript] : [transcript, source]) {
    const pages = await output.copyPages(doc, doc.getPageIndices());
    for (const page of pages) output.addPage(page);
  }
  if (output.getPageCount() !== sourceCount + transcriptCount) {
    throw new Error("PDF 合并页数不完整，已取消导出。");
  }
  const bytes = await output.save();
  // Parse final bytes before import, rather than just checking EOF.
  const final = await PDFDocument.load(bytes, { updateMetadata: false });
  if (final.getPageCount() !== sourceCount + transcriptCount) {
    throw new Error("最终 PDF 页数校验失败。");
  }
  return bytes;
}

export async function readPDFFile(file: any, maxBytes = 250 * 1024 * 1024): Promise<Uint8Array> {
  const size = Number(file.fileSize);
  if (!file.exists() || !Number.isSafeInteger(size) || size < 4 || size > maxBytes) {
    throw new Error("PDF 文件不存在、为空或超过允许的大小。");
  }
  const c = (globalThis as any).Components;
  const input = c.classes["@mozilla.org/network/file-input-stream;1"]
    .createInstance(c.interfaces.nsIFileInputStream);
  input.init(file, 0x01, 0, 0);
  const stream = c.classes["@mozilla.org/binaryinputstream;1"]
    .createInstance(c.interfaces.nsIBinaryInputStream);
  stream.setInputStream(input);
  try {
    const bytes = new Uint8Array(size);
    for (let offset = 0; offset < size;) {
      const chunk = stream.readByteArray(Math.min(65536, size - offset));
      if (!chunk.length) throw new Error("读取 PDF 文件不完整。");
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } finally { stream.close(); }
}

export async function readOriginalAttachment(attachment: any): Promise<Uint8Array> {
  const path = await attachment.getFilePathAsync();
  if (!path) throw new Error("原始 PDF 尚未下载到本机。请先下载附件。");
  const file = (Zotero.File as any).pathToFile(path);
  return readPDFFile(file);
}

export async function writePDFFile(file: any, bytes: Uint8Array): Promise<void> {
  const c = (globalThis as any).Components;
  const stream = c.classes["@mozilla.org/io/arraybuffer-input-stream;1"]
    .createInstance(c.interfaces.nsIArrayBufferInputStream);
  const buffer = bytes.slice().buffer;
  stream.setData(buffer, 0, buffer.byteLength);
  await (Zotero.File as any).putContentsAsync(file.path, stream);
}

export async function appendOriginalPDF(
  transcriptFile: any, originalAttachment: any, outputFile: any,
  originalFirst: boolean, expectedPages?: number,
): Promise<void> {
  const original = await readOriginalAttachment(originalAttachment);
  const transcript = await readPDFFile(transcriptFile);
  const merged = await combinePDFPages(original, transcript, originalFirst, expectedPages);
  await writePDFFile(outputFile, merged);
}


/** Place a source page inside a panel without cropping or rasterizing it.
 * PDF page rotation is clockwise; drawPage's rotation is counter-clockwise.
 * Embed the visible CropBox, not the entire MediaBox.
 */
async function preparePanel(out: PDFDocument, source: PDFPage,
  left: number, bottom: number, width: number, height: number,
  degrees: typeof import("pdf-lib").degrees): Promise<((target: PDFPage) => void) | undefined> {
  const box = source.getCropBox();
  if (!source.node.Contents()) return; // a genuinely blank original page
  if (!(box.width > 0 && box.height > 0)) throw new Error("无效 PDF 页面裁切框。");
  const rotation = ((source.getRotation().angle % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(rotation)) throw new Error("不支持的原页旋转角度。");
  const quarter = rotation === 90 || rotation === 270;
  const scale = Math.min(width / (quarter ? box.height : box.width),
    height / (quarter ? box.width : box.height));
  const w = box.width * scale, h = box.height * scale;
  let x = left + (width - (quarter ? h : w)) / 2;
  let y = bottom + (height - (quarter ? w : h)) / 2;
  if (rotation === 90) y += w;
  else if (rotation === 180) { x += w; y += h; }
  else if (rotation === 270) x += h;
  const embedded = await out.embedPage(source, {
    left: box.x, bottom: box.y, right: box.x + box.width, top: box.y + box.height,
  });
  const options = { x, y, width: w, height: h, rotate: degrees(-rotation) };
  return (target) => target.drawPage(embedded, options);
}

/** Each source page is matched to all independently printed translation pages.
 * Repeat the original on continuation sheets instead of shrinking or cutting
 * a long translation. Both panels are PDF vector/form objects, not screenshots.
 */
export async function composeSideBySidePDF(
  original: Uint8Array, transcripts: AsyncIterable<{ pageIndex: number; bytes: Uint8Array }>,
  expectedPages?: number,
): Promise<Uint8Array> {
  const { PDFDocument, degrees, rgb } = await import("pdf-lib");
  const source = await PDFDocument.load(original, { updateMetadata: false });
  const count = source.getPageCount();
  if (!count || (expectedPages !== undefined && count !== expectedPages)) {
    throw new Error("左右对照：原始页数不匹配。");
  }
  const out = await PDFDocument.create();
  const panelW = 595.28, panelH = 841.89, gutter = 16;
  let index = 0, sheets = 0;
  for await (const entry of transcripts) {
    if (entry.pageIndex !== index || index >= count) throw new Error("左右对照：译文页顺序错误或缺页。");
    const translated = await PDFDocument.load(entry.bytes, { updateMetadata: false });
    if (!translated.getPageCount()) throw new Error("左右对照：译文页面为空。");
    const drawOriginal = await preparePanel(out, source.getPage(index), 0, 0, panelW, panelH, degrees);
    for (const rightPage of translated.getPages()) {
      const drawTranslation = await preparePanel(out, rightPage, panelW + gutter, 0, panelW, panelH, degrees);
      const sheet = out.addPage([panelW * 2 + gutter, panelH]);
      sheet.drawLine({ start: { x: panelW + gutter / 2, y: 12 },
        end: { x: panelW + gutter / 2, y: panelH - 12 },
        thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
      drawOriginal?.(sheet);
      drawTranslation?.(sheet);
      sheets++;
    }
    index++;
  }
  if (index !== count || !sheets) throw new Error("左右对照：原始页面未全部配对。");
  const bytes = await out.save();
  if ((await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount() !== sheets) {
    throw new Error("左右对照：最终 PDF 页数校验失败。");
  }
  return bytes;
}
