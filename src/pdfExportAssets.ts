/**
 * Freeze images in the current SDT reader before printing its cloned HTML.
 *
 * The cloned HTML is loaded in a different HiddenBrowser. In-memory blob:
 * URLs belong to the reader, lazy <img> elements may not have loaded, and
 * canvas.cloneNode() deliberately does NOT copy the canvas bitmap.
 * Embed assets as data: URLs, without mutating Zotero's live reader.
 *
 * Zotero renders source-PDF figure crops only as they approach the viewport.
 * Prepare those crops before taking the export snapshot.
 */
import { recoverReadingFigure } from "./pdfReadingFigures";

export interface ExportAssetReport {
  imageElements: number;
  canvasElements: number;
  embedded: number;
  preserved: number;
  failed: number;
  absentFigureCaptions: number;
}

const MAX_EMBEDDED_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 96 * 1024 * 1024;

function exportElements<T extends Element>(root: HTMLElement, selector: string): T[] {
  return Array.from(root.querySelectorAll(selector)) as T[];
}

/** Ask the native SDT view to render offscreen source crops before cloning. */
export async function preparePDFExportFigures(view: any, root: HTMLElement, reader: any): Promise<void> {
  const pending = exportElements<HTMLElement>(
    root, 'figure.sdt-source-crop[data-source-crop-state="ready"], ' +
      'figure.sdt-source-crop[data-source-crop-state="loading"], ' +
      'figure.sdt-source-crop[data-source-crop-state="unavailable"], ' +
      'figure.sdt-source-crop[data-source-crop-state="loaded"]',
  );
  for (const figure of pending) {
    let expired = false;
    const render = async () => {
      if (figure.dataset.sourceCropState === "ready") await view?._loadSourceCrop?.(figure);
      // The reader can start a lazy crop between selection and this call.
      while (!expired && figure.dataset.sourceCropState === "loading" && figure.isConnected) {
        await Zotero.Promise.delay(50);
      }
      if (!expired) await recoverReadingFigure(reader, view, figure, () => expired);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        render(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("原始 PDF 图表提取超时。")), 20000);
        }),
      ]);
    } catch (error) {
      Zotero.logError(error as Error);
    } finally {
      expired = true;
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function normalizeSrc(image: HTMLImageElement): string {
  const raw = image.currentSrc || image.getAttribute("src") || image.getAttribute("data-src") || "";
  if (!raw || raw.trim().startsWith("data:")) return raw.trim();
  try {
    return new URL(raw, image.ownerDocument?.baseURI || "about:blank").href;
  } catch (_) {
    return raw;
  }
}

function mimeFor(url: string, suppliedType: string): string {
  if (/^image\/(?:png|jpeg|webp|gif|svg\+xml|bmp|tiff)$/iu.test(suppliedType)) {
    return suppliedType;
  }
  if (/\.jpe?g(?:[?#]|$)/iu.test(url)) return "image/jpeg";
  if (/\.webp(?:[?#]|$)/iu.test(url)) return "image/webp";
  if (/\.svg(?:[?#]|$)/iu.test(url)) return "image/svg+xml";
  if (/\.gif(?:[?#]|$)/iu.test(url)) return "image/gif";
  return "image/png";
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let output = "";
  // Do not pass a multi-megabyte array to String.fromCharCode(...bytes).
  for (let i = 0; i < bytes.length; i += 0x8000) {
    output += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return Zotero.getMainWindow().btoa(output);
}

async function loadImageBytes(url: string, doc: Document): Promise<{ body: ArrayBuffer; mime: string }> {
  // A blob URL often only exists in the document that created it.
  const win = doc.defaultView as (Window & { fetch?: typeof fetch }) | null;
  // Only reader-scoped blob URLs require the originating window. Normal
  // HTTP/resource URLs use Zotero.HTTP with a bounded 15-second timeout;
  // window.fetch() can hang indefinitely during PDF export.
  if (/^blob:/iu.test(url)) {
    if (!win || typeof win.fetch !== "function") {
      throw new Error("Reader blob URL is not accessible.");
    }
    const response = await win.fetch(url, { credentials: "omit" });
    if (!response.ok) throw new Error("Cannot load reader blob image.");
    const blob = await response.blob();
    return { body: await blob.arrayBuffer(), mime: mimeFor(url, blob.type) };
  }
  const xhr = await Zotero.HTTP.request("GET", url, {
    responseType: "arraybuffer",
    timeout: 15000,
  });
  if (xhr?.status !== 200) throw new Error("Cannot retrieve original image bytes.");
  // Firefox may return a cross-compartment ArrayBuffer, which fails
  // instanceof ArrayBuffer against the plugin's global constructor.
  const response = xhr.response;
  let bytes: Uint8Array | null = null;
  if (ArrayBuffer.isView(response)) {
    bytes = new Uint8Array(response.buffer, response.byteOffset, response.byteLength);
  } else if (response && typeof response.byteLength === "number") {
    bytes = new Uint8Array(response as ArrayBuffer);
  }
  if (!bytes?.length) throw new Error("Image response contains no usable bytes.");
  const contentType = typeof xhr.getResponseHeader === "function"
    ? String(xhr.getResponseHeader("content-type") || "").split(";")[0]
    : "";
  return { body: bytes.slice().buffer as ArrayBuffer, mime: mimeFor(url, contentType) };
}

function setEmbeddedImage(target: HTMLImageElement, url: string): void {
  target.removeAttribute("srcset");
  target.removeAttribute("sizes");
  target.removeAttribute("data-src");
  target.setAttribute("src", url);
  target.setAttribute("loading", "eager");
  // The source may have been picked via <picture> and override our new src.
  if (target.parentElement?.tagName.toLowerCase() === "picture") {
    for (const source of Array.from(target.parentElement.querySelectorAll("source")) as Element[]) {
      source.remove();
    }
  }
}

function isCaptionWithoutNearbyImage(caption: Element): boolean {
  if (!/^\s*(?:fig(?:ure)?\.?\s*\d+|图\s*\d+)/iu.test(caption.textContent || "")) {
    return false;
  }
  const container = caption.closest("figure");
  if (container) return !container.querySelector("img, svg, canvas, picture");
  const previous = caption.previousElementSibling;
  return !previous?.matches("figure, img, svg, canvas, picture") &&
    !previous?.querySelector("img, svg, canvas, picture");
}

/**
 * The original and its clone have identical DOM element order at this stage.
 * Embed before removal of unfinished translation placeholders.
 */
export async function freezePDFExportImages(
  source: HTMLElement,
  clone: HTMLElement,
): Promise<ExportAssetReport> {
  const originalImages = exportElements<HTMLImageElement>(source, "img");
  const cloneImages = exportElements<HTMLImageElement>(clone, "img");
  const originalCanvases = exportElements<HTMLCanvasElement>(source, "canvas");
  const cloneCanvases = exportElements<HTMLCanvasElement>(clone, "canvas");

  const report: ExportAssetReport = {
    imageElements: originalImages.length,
    canvasElements: originalCanvases.length,
    embedded: 0,
    preserved: 0,
    failed: 0,
    absentFigureCaptions: exportElements<Element>(
      source, "figcaption, .sdt-caption",
    ).filter(isCaptionWithoutNearbyImage).length,
  };
  let totalBytes = 0;
  const count = Math.min(originalImages.length, cloneImages.length);
  for (let i = 0; i < count; i++) {
    const original = originalImages[i];
    const target = cloneImages[i];
    const src = normalizeSrc(original);
    if (!src) {
      report.failed++;
      continue;
    }
    if (src.startsWith("data:")) {
      setEmbeddedImage(target, src);
      report.preserved++;
      continue;
    }
    try {
      const doc = original.ownerDocument;
      if (!doc) throw new Error("Image element has no owner document.");
      const { body, mime } = await loadImageBytes(src, doc);
      if (!body.byteLength || body.byteLength > MAX_EMBEDDED_IMAGE_BYTES ||
        totalBytes + body.byteLength > MAX_TOTAL_IMAGE_BYTES) {
        throw new Error("Image exceeds export size limit.");
      }
      totalBytes += body.byteLength;
      setEmbeddedImage(target, "data:" + mime + ";base64," + bufferToBase64(body));
      report.embedded++;
    } catch (_) {
      // Do not export a dead reader-only blob URL into HiddenBrowser.
      if (/^blob:/iu.test(src)) target.removeAttribute("src");
      report.failed++;
    }
  }
  if (cloneImages.length !== originalImages.length) {
    report.failed += Math.abs(cloneImages.length - originalImages.length);
  }

  for (let i = 0; i < Math.min(originalCanvases.length, cloneCanvases.length); i++) {
    const original = originalCanvases[i];
    const target = cloneCanvases[i];
    try {
      const dataURI = original.toDataURL("image/png");
      if (!/^data:image\/png;base64,/iu.test(dataURI) || dataURI.length < 32) {
        throw new Error("Canvas has no pixel data.");
      }
      const doc = target.ownerDocument;
      if (!doc) throw new Error("Canvas clone has no owner document.");
      const replacement = doc.createElement("img");
      replacement.setAttribute("src", dataURI);
      replacement.setAttribute("alt", original.getAttribute("aria-label") || "PDF figure");
      replacement.setAttribute("width", String(original.width));
      replacement.setAttribute("height", String(original.height));
      replacement.style.cssText = original.style.cssText;
      target.replaceWith(replacement);
      report.embedded++;
    } catch (_) {
      // A tainted canvas cannot be serialized. Never pretend it was copied.
      report.failed++;
    }
  }
  if (cloneCanvases.length !== originalCanvases.length) {
    report.failed += Math.abs(cloneCanvases.length - originalCanvases.length);
  }

  // Inline SVG is preserved by cloneNode(), but nested <image> elements can
  // still reference blob: URLs owned by the reader frame.
  const svgImages = exportElements<Element>(source, "svg image");
  const targetSvgImages = exportElements<Element>(clone, "svg image");
  for (let i = 0; i < Math.min(svgImages.length, targetSvgImages.length); i++) {
    const original = svgImages[i];
    const target = targetSvgImages[i];
    const raw = original.getAttribute("href") ||
      original.getAttributeNS("http://www.w3.org/1999/xlink", "href") || "";
    if (!raw) continue;
    if (raw.startsWith("data:")) {
      report.preserved++;
      continue;
    }
    try {
      const uri = new URL(raw, original.ownerDocument?.baseURI || "about:blank").href;
      const owner = original.ownerDocument;
      if (!owner) throw new Error("SVG has no document.");
      const { body, mime } = await loadImageBytes(uri, owner);
      if (!body.byteLength || body.byteLength > MAX_EMBEDDED_IMAGE_BYTES ||
          totalBytes + body.byteLength > MAX_TOTAL_IMAGE_BYTES) {
        throw new Error("SVG image is too large.");
      }
      totalBytes += body.byteLength;
      const embedded = "data:" + mime + ";base64," + bufferToBase64(body);
      target.setAttribute("href", embedded);
      target.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", embedded);
      report.embedded++;
    } catch (_) {
      report.failed++;
    }
  }
  return report;
}
