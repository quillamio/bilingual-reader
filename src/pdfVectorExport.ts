/**
 * Embed actual PDF pages instead of printing screenshots or relying on the
 * reading-mode DOM. Retains original page content, fonts, image XObjects and
 * vector artwork. Document-level bookmarks, forms and signatures are not
 * guaranteed to survive a new combined PDF; the source attachment is untouched.
 */
import type { PDFDocument, PDFPage } from "pdf-lib";
import { PDF_DEADLINES, PDFOperationTimeoutError, withPDFOperationDeadline, writeTemporaryWithDeadline } from "./pdfOperationDeadline.ts";
import type { PDFExportTask } from "./pdfExportTask.ts";

export async function readPDFFile(file: any, maxBytes = 250 * 1024 * 1024, task?: PDFExportTask): Promise<Uint8Array> {
  task?.throwIfCancelled();
  const size = file.exists() ? Number(file.fileSize) : 0;
  if (!Number.isSafeInteger(size) || size < 4 || size > maxBytes) {
    throw new Error("PDF 文件不存在、为空或超过允许的大小。");
  }
  const io = (globalThis as any).IOUtils;
  if (typeof io?.read === "function") {
    const bytes = await withPDFOperationDeadline<Uint8Array>("PDF 文件读取", PDF_DEADLINES.fileRead,
      () => io.read(file.path, { maxBytes: size + 1 }), undefined, task);
    if (bytes.length !== size) throw new Error("读取期间 PDF 文件大小发生变化。");
    return bytes;
  }
  // Legacy synchronous stream fallback: yield periodically so the UI can recover.
  const deadline = Date.now() + PDF_DEADLINES.fileRead;
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
      if (offset % 1048576 === 0) await Zotero.Promise.delay(0);
      task?.throwIfCancelled();
      if (Date.now() >= deadline) throw new PDFOperationTimeoutError("PDF 文件读取", PDF_DEADLINES.fileRead);
    }
    return bytes;
  } finally { stream.close(); }
}

export async function readOriginalAttachment(attachment: any, task?: PDFExportTask): Promise<Uint8Array> {
  const path = await withPDFOperationDeadline<any>("原始 PDF 附件路径读取", PDF_DEADLINES.fileRead,
    () => attachment.getFilePathAsync(), undefined, task);
  if (!path) throw new Error("原始 PDF 尚未下载到本机。请先下载附件。");
  const file = (Zotero.File as any).pathToFile(path);
  return readPDFFile(file, undefined, task);
}

export async function writePDFFile(file: any, bytes: Uint8Array, task?: PDFExportTask): Promise<void> {
  task?.throwIfCancelled();
  const c = (globalThis as any).Components;
  const stream = c.classes["@mozilla.org/io/arraybuffer-input-stream;1"]
    .createInstance(c.interfaces.nsIArrayBufferInputStream);
  const buffer = bytes.slice().buffer;
  stream.setData(buffer, 0, buffer.byteLength);
  await writeTemporaryWithDeadline("PDF 临时文件写入", PDF_DEADLINES.fileWrite,
    () => (Zotero.File as any).putContentsAsync(file.path, stream),
    () => { if (file.exists()) file.remove(false); }, task);
}

/** Place a source page inside a panel without cropping or rasterizing it.
 * PDF page rotation is clockwise; drawPage's rotation is counter-clockwise.
 * Embed the visible CropBox, not the entire MediaBox.
 */
async function embedPanel(out: PDFDocument, source: PDFPage,
  width: number, height: number) {
  const { degrees } = await import("pdf-lib");
  const box = source.getCropBox();
  if (!source.node.Contents()) return; // a genuinely blank original page
  if (!(box.width > 0 && box.height > 0)) throw new Error("无效 PDF 页面裁切框。");
  const rotation = ((source.getRotation().angle % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(rotation)) throw new Error("不支持的原页旋转角度。");
  const quarter = rotation === 90 || rotation === 270;
  const scale = Math.min(width / (quarter ? box.height : box.width),
    height / (quarter ? box.width : box.height));
  const w = box.width * scale, h = box.height * scale;
  let x = (width - (quarter ? h : w)) / 2;
  let y = (height - (quarter ? w : h)) / 2;
  if (rotation === 90) y += w;
  else if (rotation === 180) { x += w; y += h; }
  else if (rotation === 270) x += h;
  const embedded = await out.embedPage(source, {
    left: box.x, bottom: box.y, right: box.x + box.width, top: box.y + box.height,
  });
  return { embedded, x, y, width: w, height: h, rotate: degrees(-rotation) };
}

/** Pair each source once and keep overflow in the right panel of later sheets. */
export async function composeSideBySidePDF(
  original: Uint8Array, transcripts: AsyncIterable<{ pageIndex: number; bytes?: Uint8Array; continuation?: Uint8Array }>,
  expectedPages?: number, task?: PDFExportTask,
): Promise<Uint8Array> {
  task?.throwIfCancelled();
  const { PDFDocument, rgb } = await import("pdf-lib");
  const source = await PDFDocument.load(original, { updateMetadata: false });
  const count = source.getPageCount();
  if (!count || (expectedPages !== undefined && count !== expectedPages)) {
    throw new Error("左右对照：原始页数不匹配。");
  }
  const out = await PDFDocument.create();
  const panelW = 595.28, panelH = 841.89, gutter = 16;
  let index = 0, sheets = 0;
  for await (const entry of transcripts) {
    task?.throwIfCancelled();
    if (entry.pageIndex !== index || index >= count) throw new Error("左右对照：译文页顺序错误或缺页。");
    const translated = entry.bytes && await PDFDocument.load(entry.bytes, { updateMetadata: false });
    if (translated && !translated.getPageCount()) throw new Error("左右对照：译文页面为空。");
    const continuation = entry.continuation && await PDFDocument.load(entry.continuation, { updateMetadata: false });
    const originalPage = source.getPage(index);
    const left = await embedPanel(out, originalPage, panelW, panelH);
    const rightPages = [...(translated?.getPages() || []), ...(continuation?.getPages() || [])];
    if (!rightPages.length) rightPages.push(originalPage);
    for (const [part, rightPage] of rightPages.entries()) {
      task?.throwIfCancelled();
      const sheet = out.addPage([panelW * 2 + gutter, panelH]);
      sheet.drawLine({ start: { x: panelW + gutter / 2, y: 12 },
        end: { x: panelW + gutter / 2, y: panelH - 12 },
        thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
      if (part === 0 && left) sheet.drawPage(left.embedded, left);
      const right = rightPage === originalPage ? left : await embedPanel(out, rightPage, panelW, panelH);
      if (right) sheet.drawPage(right.embedded, { ...right, x: right.x + panelW + gutter });
      sheets++;
    }
    index++;
  }
  if (index !== count || !sheets) throw new Error("左右对照：原始页面未全部配对。");
  task?.throwIfCancelled();
  const bytes = await out.save();
  task?.throwIfCancelled();
  if ((await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount() !== sheets) {
    throw new Error("左右对照：最终 PDF 页数校验失败。");
  }
  return bytes;
}
