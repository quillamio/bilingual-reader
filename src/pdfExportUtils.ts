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
    "blockquote", "aside", "figcaption", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "pre",
  ].join(",");

  const blocks: HTMLElement[] = [root];
  // Zotero's specialized DOM declarations can infer querySelectorAll elements
  // as unknown. This mirrors the cast used in the reader's existing code.
  const descendants = Array.from(root.querySelectorAll(blockSelector)) as HTMLElement[];
  for (const node of descendants) {
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
      "height", "min-height", "max-height", "block-size", "min-block-size", "max-block-size",
      "clip", "clip-path", "contain", "content-visibility", "mask",
      "margin-top", "margin-bottom", "margin-block-start", "margin-block-end",
      "page-break-before", "page-break-after", "page-break-inside",
      "break-before", "break-after", "break-inside", "columns", "column-count", "column-width",
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


/**
 * Use CSS @page as the sole authority for PDF print margins.
 *
 * Do not inherit a user's previous printer settings (which can add a second
 * margin/scale on top of the 16–17 mm CSS @page margins). The Pringle 2011
 * regression PDF had every page shifted left by 51.8125 pt, with 31,573
 * glyphs completely outside the A4 MediaBox. This is a print geometry bug,
 * not missing translations.
 *
 * nsIPrintSettings margins are INCHES; @page is responsible for millimetres.
 */
export function configureBilingualPDFPrintSettings(settings: any): void {
  settings.marginTop = 0;
  settings.marginRight = 0;
  settings.marginBottom = 0;
  settings.marginLeft = 0;
  settings.scaling = 1;
  settings.shrinkToFit = false;
  // Fix physical paper dimensions, not merely the CSS viewport. Older Gecko
  // settings objects may expose only a subset of these properties.
  if ("paperSizeUnit" in settings) settings.paperSizeUnit = 1; // millimetres
  if ("paperWidth" in settings) settings.paperWidth = 210;
  if ("paperHeight" in settings) settings.paperHeight = 297;
  if ("orientation" in settings) settings.orientation = 0; // portrait
  for (const edge of ["Top", "Right", "Bottom", "Left"]) {
    for (const prefix of ["unwriteableMargin", "edge"]) {
      const property = prefix + edge;
      if (property in settings) settings[property] = 0;
    }
  }

  // Newer Gecko builds expose these properties. Do not assign unsupported
  // properties on an XPCOM WrappedNative, which would throw in Zotero 10.
  if ("honorPageRuleMargins" in settings) settings.honorPageRuleMargins = true;
  if ("ignoreUnwriteableMargins" in settings) settings.ignoreUnwriteableMargins = true;
  if ("usePageRuleSizeAsPaperSize" in settings) settings.usePageRuleSizeAsPaperSize = true;
}
