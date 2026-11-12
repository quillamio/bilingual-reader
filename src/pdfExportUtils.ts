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
