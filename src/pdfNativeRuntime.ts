/**
 * PDF.js extraction directly from the normal PDF viewer's PDFDocumentProxy.
 * Does NOT use Zotero SDT reading-mode data, getData().structure,
 * #sdt-content, or any reading-mode image blocks.
 *
 * We initially reuse the PDF.js document already loaded by Zotero's ordinary
 * PDF viewer; no duplicate network access or bundling of a second PDF.js.
 * It requires an open normal PDF tab (not the SDT reflowed reading mode).
 */
import { extractPDFJSPage, type NativeDocument, type PDFJSTextItem } from "./pdfNativeModel";

interface PDFProxyHandle {
  pdf: any;
  contentWindow: any;
}
function findPDFProxyWindow(value: any): any {
  try {
    return value?.wrappedJSObject || value || null;
  } catch (_) {
    return value || null;
  }
}
export function getNormalPDFProxy(reader: any): PDFProxyHandle | null {
  const internal = reader?._internalReader || reader;
  const possible: any[] = [
    reader?._iframeWindow,
    internal?._iframeWindow,
    internal?._primaryView?._iframeWindow,
    internal?._secondaryView?._iframeWindow,
    internal?._primaryPDFView?._iframeWindow,
    internal?._secondaryPDFView?._iframeWindow,
    internal?._primaryView?._pdfView?._iframeWindow,
    internal?._secondaryView?._pdfView?._iframeWindow,
  ];
  for (const view of [
    internal?._primaryPDFView, internal?._secondaryPDFView,
    internal?._primaryView, internal?._secondaryView,
    internal?._primaryView?._pdfView, internal?._secondaryView?._pdfView,
  ]) {
    try {
      if (view?._pdfDocument?.getPage &&
          Number.isInteger(view._pdfDocument.numPages) &&
          view._pdfDocument.numPages > 0) {
        return { pdf: view._pdfDocument, contentWindow: view?._iframeWindow || null };
      }
    } catch (_) { /* Detached view */ }
  }
  for (const win of [...possible]) {
    try {
      if (win?.frames) {
        const size = Math.min(6, Number(win.frames.length) || 0);
        for (let i = 0; i < size; i++) possible.push(win.frames[i]);
      }
    } catch (_) { /* Detached frame */ }
  }
  const unique = new Set<any>();
  for (const candidate of possible) {
    const win = findPDFProxyWindow(candidate);
    if (!win || unique.has(win)) continue;
    unique.add(win);
    try {
      const pdf = win?.PDFViewerApplication?.pdfDocument ||
        win?.PDFViewerApplication?.pdfViewer?.pdfDocument ||
        win?.pdfDocument;
      if (pdf?.getPage && Number.isInteger(pdf.numPages)) {
        return { pdf, contentWindow: win };
      }
    } catch (_) { /* Inaccessible privileged frame */ }
  }
  if (internal?._pdfDocument?.getPage &&
      Number.isInteger(internal._pdfDocument.numPages) &&
      internal._pdfDocument.numPages > 0) {
    return { pdf: internal._pdfDocument, contentWindow: null };
  }
  return null;
}
export interface NativePDFProgress {
  page: number;
  pages: number;
  stage: "parse" | "render";
}
function cloneForWindow<T>(value: T, target: any): T {
  if (!target) return value;
  try {
    const utils = (globalThis as any).Components?.utils || (globalThis as any).Cu;
    if (utils?.cloneInto) return utils.cloneInto(value, target) as T;
  } catch (_) { /* Same-origin/same compartment may not need cloneInto. */ }
  return value;
}
export async function parseNormalPDFWithPDFJS(
  pdf: any,
  onProgress?: (progress: NativePDFProgress) => void,
): Promise<NativeDocument> {
  if (!pdf?.getPage || !Number.isInteger(pdf.numPages) || pdf.numPages < 1) {
    throw new Error("无法访问原始 PDF.js 文档，请先打开普通 PDF 页面视图。");
  }
  const pages = [];
  const warnings: string[] = [];
  for (let index = 0; index < pdf.numPages; index++) {
    onProgress?.({ page: index + 1, pages: pdf.numPages, stage: "parse" });
    const page = await pdf.getPage(index + 1);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const native = extractPDFJSPage(
      index, viewport.width, viewport.height,
      (content?.items || []) as PDFJSTextItem[],
    );
    if (!native.blocks.length) {
      warnings.push("第 " + (index + 1) + " 页未提取到可翻译文本（扫描 PDF 可能需要 OCR）。");
    }
    pages.push(native);
    page.cleanup?.();
  }
  return { source: "pdfjs", pages, warnings };
}
export async function snapshotPDFPage(
  pdf: any,
  pageIndex: number,
  doc: Document,
  contentWindow: any,
  scale = 1.25,
): Promise<string> {
  const page = await pdf.getPage(pageIndex + 1);
  const viewport = page.getViewport(cloneForWindow({ scale }, contentWindow));
  // Keep canvas and PDF.js rendering context in the viewer's compartment
  // when possible. Firefox's Xray wrappers may reject a canvas context that
  // originated from the privileged Zotero preferences window.
  let renderDocument: Document = doc;
  try { if (contentWindow?.document) renderDocument = contentWindow.document; }
  catch (_) { /* Retain caller's document */ }
  const canvas = renderDocument.createElement("canvas") as HTMLCanvasElement;
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const context = canvas.getContext("2d", { alpha: false }) as CanvasRenderingContext2D | null;
  if (!context) throw new Error("无法为原始 PDF 页面创建 Canvas。");
  // Draw white background for JPEG export, including PDFs with transparent
  // backgrounds. The original page's vector/pixel Figure are both present.
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  try {
    const task = page.render(cloneForWindow({
      canvasContext: context, viewport, background: "rgb(255,255,255)",
    }, contentWindow));
    await task.promise;
    const image = canvas.toDataURL("image/jpeg", 0.83);
    if (!image.startsWith("data:image/jpeg;base64,") || image.length < 64) {
      throw new Error("PDF.js 页面绘制结果无效。");
    }
    return image;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    page.cleanup?.();
  }
}
export async function getOriginalPDFBytes(pdf: any): Promise<Uint8Array> {
  if (typeof pdf?.getData !== "function") {
    throw new Error("当前 PDF.js 文档未提供原始字节。Docling 无法处理此文件。");
  }
  const data = await pdf.getData();
  if (!data || typeof data.length !== "number" || data.length < 4) {
    throw new Error("PDF.js 返回的原始文件为空。");
  }
  if (data.length > 30 * 1024 * 1024) {
    throw new Error("Docling 本地接口目前只接受不超过 30 MB 的原始 PDF。");
  }
  // Copy to privileged plugin compartment (pdf.js may return an Xray proxy).
  const result = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) result[i] = data[i];
  return result;
}
