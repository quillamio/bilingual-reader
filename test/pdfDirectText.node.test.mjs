import assert from "node:assert/strict";
import test from "node:test";
import { wrapPDFText, requirePDFGlyphs } from "../src/pdfDirectText.ts";
const measure = value => Array.from(value).length;
test("wrap uses actual width and preserves all non-whitespace characters", () => {
  const source = "BRRIGHT0123 中文译文，HR = 3.28。";
  const lines = wrapPDFText(source, 8, measure);
  assert.ok(lines.every(line => measure(line) <= 8));
  assert.equal(lines.join("").replace(/\s/gu,""), source.replace(/\s/gu,""));
});
test("long words split by code point without splitting surrogate pairs", () => {
  assert.deepEqual(wrapPDFText("A𠮷BC", 2, measure), ["A𠮷","BC"]);
});
test("preserves explicit blank lines and refuses impossible glyph width", () => {
  assert.deepEqual(wrapPDFText("a\n\nb", 4, measure), ["a","","b"]);
  assert.throws(() => wrapPDFText("A", 1, () => 2), /glyph/);
});
test("missing glyph is reported instead of silently replacing it", () => {
  const chars = new Set(Array.from("译文HR3.28").map(c => c.codePointAt(0)));
  assert.doesNotThrow(() => requirePDFGlyphs("译文 HR 3.28", chars));
  assert.throws(() => requirePDFGlyphs("译文𠮷", chars), /cover/);
});
