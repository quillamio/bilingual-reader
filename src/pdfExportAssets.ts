/**
 * Freeze images in the current SDT reader before printing its cloned HTML.
 *
 * The cloned HTML is loaded in a different HiddenBrowser. In-memory blob:
 * URLs belong to the reader, lazy <img> elements may not have loaded, and
 * canvas.cloneNode() deliberately does NOT copy the canvas bitmap.
 * Embed assets as data: URLs, without mutating Zotero's live reader.
 *
 * Missing Figure blocks in Zotero's SDT structure cannot be reconstructed
 * by this module; a separate source-PDF image/figure extraction path is needed.
 */
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

function normalizeSrc(image: HTMLImageElement): string {
  const raw = image.currentSrc || image.getAttribute("src") || image.getAttribute("data-src") || "";
  if (!raw || raw.trim().startsWith("data:")) return raw.trim();
  try {
    return new URL(raw, image.ownerDocument.baseURI).href;
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
  if (win && typeof win.fetch === "function") {
    try {
      const response = await win.fetch(url, { credentials: "omit" });
      if (response.ok) {
        const blob = await response.blob();
        return { body: await blob.arrayBuffer(), mime: mimeFor(url, blob.type) };
      }
    } catch (_) {
      // Zotero's privileged HTTP path handles resource:/chrome: URLs.
    }
  }

  // Zotero.HTTP cannot retrieve reader-specific blob URLs.
  if (/^blob:/iu.test(url)) throw new Error("Reader blob URL is not accessible.");
  const xhr = await Zotero.HTTP.request("GET", url, {
    responseType: "arraybuffer",
    timeout: 15000,
  });
  if (xhr?.status !== 200 || !(xhr.response instanceof ArrayBuffer)) {
    throw new Error("Cannot retrieve original image bytes.");
  }
  const contentType = typeof xhr.getResponseHeader === "function"
    ? String(xhr.getResponseHeader("content-type") || "").split(";")[0]
    : "";
  return { body: xhr.response, mime: mimeFor(url, contentType) };
}

function setEmbeddedImage(target: HTMLImageElement, url: string): void {
  target.removeAttribute("srcset");
  target.removeAttribute("sizes");
  target.removeAttribute("data-src");
  target.setAttribute("src", url);
  target.setAttribute("loading", "eager");
  // The source may have been picked via <picture> and override our new src.
  if (target.parentElement?.tagName.toLowerCase() === "picture") {
    for (const source of Array.from(target.parentElement.querySelectorAll("source"))) {
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
      const { body, mime } = await loadImageBytes(src, original.ownerDocument);
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
      const replacement = target.ownerDocument.createElement("img");
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
  return report;
}
