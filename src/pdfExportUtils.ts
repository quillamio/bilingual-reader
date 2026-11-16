/** Filename and PDF signature checks for Zotero's bilingual PDF export. */
export function sanitizeExportFileBaseName(value: string, maxBytes = 180): string {
  const safeCharacters = Array.from(value.replace(/\.pdf$/i, ""), (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 || '\\/:*?"<>|'.includes(character) ? "_" : character;
  });
  const cleaned = safeCharacters
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  const name = cleaned || "中英对照翻译";
  const encoder = new TextEncoder();
  let truncated = "";
  for (const character of name) {
    if (encoder.encode(truncated + character).length > maxBytes) break;
    truncated += character;
  }
  truncated = truncated.replace(/[. ]+$/g, "") || "中英对照翻译";
  // Windows device names are reserved even when followed by an extension.
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(truncated)
    ? `_${truncated}`
    : truncated;
}

export function hasCompletePDFMarkers(header: string, tail: string): boolean {
  if (!/^%PDF-\d\.\d/.test(header)) return false;
  let last = tail.length - 1;
  // PDF files can end in whitespace or padding bytes after %%EOF.
  while (last >= 0 && tail.charCodeAt(last) <= 32) last -= 1;
  return tail.slice(0, last + 1).endsWith("%%EOF");
}


/**
 * Normalize the *clone* of Zotero's SDT reading-mode content before print.
 *
 * Reading mode can attach viewport-relative positions, transforms, negative
 * margins and fixed widths to semantic blocks. Those coordinates are valid
 * inside Zotero's reflowed reader but can place the first characters outside
 * the PDF printable area after the DOM is cloned into HiddenBrowser.
 *
 * Do not mutate the live reader DOM or the geometry of SVG/canvas/figures.
 */
export function normalizeExportContent(root: HTMLElement): void {
  const blockSelector = [
    "#sdt-content",
    "p", "h1", "h2", "h3", "h4", "h5", "h6",
    "div", "section", "article", "li", "ul", "ol",
    "blockquote", "aside", "figcaption",
  ].join(",");

  const blocks: HTMLElement[] = [root];
  for (const node of Array.from(root.querySelectorAll<HTMLElement>(blockSelector))) {
    if (node.namespaceURI === "http://www.w3.org/1999/xhtml") blocks.push(node);
  }
  for (const element of blocks) {
    if (element.closest("figure, picture, svg, math") && !element.matches("figcaption")) {
      continue; // Keep positioned figure crops and scientific artwork intact.
    }
    const style = element.style;
    if (!style || !style.length) continue;
    for (const prop of [
      "position", "left", "right", "top", "bottom", "inset",
      "transform", "translate", "float",
      "width", "min-width", "max-width",
      "margin-left", "margin-right",
      "overflow", "overflow-x", "overflow-y",
    ]) {
      style.removeProperty(prop);
    }
    // A first-line text-indent copied from a viewport-aligned SDT block can
    // also push the first characters outside of the printed page.
    if (element.matches("p, li, blockquote, figcaption, aside")) {
      style.removeProperty("text-indent");
    }
    if (!style.length) element.removeAttribute("style");
  }
}
