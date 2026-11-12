/** Filename and PDF signature checks for Zotero's bilingual PDF export. */
export function sanitizeExportFileBaseName(value: string, maxBytes = 180): string {
  const cleaned = value
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_")
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
  return /^%PDF-\d\.\d/.test(header) && /%%EOF[\x00-\x20]*$/.test(tail);
}
