/** Pure PDF line wrapping using the embedded font's actual advances. */
export function wrapPDFText(text: string, width: number, measure: (text: string) => number): string[] {
  if (!Number.isFinite(width) || width <= 0) throw new Error("Invalid PDF text width");
  const result: string[] = [];
  for (const paragraph of text.replace(/\r\n?/gu, "\n").split("\n")) {
    const pieces = paragraph.replace(/[^\S\n]+/gu, " ").trim()
      .match(/[\p{Script=Han}，。；：、！？（）]|[^\s\p{Script=Han}，。；：、！？（）]+| /gu) || [];
    let line = "";
    for (const piece of pieces) {
      const tokens = measure(piece) > width ? Array.from(piece) : [piece];
      for (const token of tokens) {
        if (measure(token) > width) throw new Error("Single glyph exceeds PDF text width");
        if (line && measure(line + token) > width) {
          result.push(line.trimEnd());
          line = "";
        }
        line += line ? token : token.trimStart();
      }
    }
    result.push(line.trimEnd());
  }
  return result;
}
export function requirePDFGlyphs(text: string, chars: ReadonlySet<number>): void {
  for (const character of text) {
    if (/\s/u.test(character)) continue;
    if (!chars.has(character.codePointAt(0)!)) throw new Error("Direct PDF font does not cover every character");
  }
}
