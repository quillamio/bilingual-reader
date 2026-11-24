/**
 * Copy actual PDF pages instead of printing screenshots or relying on the
 * reading-mode DOM. Retains original page content, fonts, image XObjects and
 * vector artwork. Document-level bookmarks, forms and signatures are not
 * guaranteed to survive a new combined PDF; the source attachment is untouched.
 */
import { PDFDocument } from "pdf-lib";

export async function combinePDFPages(
  original: Uint8Array, bilingual: Uint8Array, originalFirst = true,
  expectedOriginalPages?: number,
): Promise<Uint8Array> {
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
