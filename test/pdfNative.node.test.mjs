import assert from "node:assert/strict";
import test from "node:test";
import {
  pdfjsTextToLines, orderPDFJSLines, extractPDFJSPage,
  validateNativeDocument,
} from "../src/pdfNativeModel.ts";
import { uncoveredBlocks } from "../src/pdfCoverage.ts";
import { buildNativeBilingualHTML } from "../src/pdfNativeHtml.ts";

function item(str, x, y, width = 170) {
  return { str, transform: [10, 0, 0, 10, x, y], width, height: 10 };
}
test("PDF.js two-column lines retain left-column before right-column reading order", () => {
  const items = [];
  for (let index = 0; index < 4; index++) {
    items.push(item("Left line " + (index + 1), 40, 720 - index * 15, 256));
    items.push(item("Right line " + (index + 1), 306, 720 - index * 15, 256));
  }
  const lines = pdfjsTextToLines(items, 600);
  assert.equal(lines.length, 8);
  const reading = orderPDFJSLines(lines, 600).map((line) => line.text);
  assert.deepEqual(reading, [
    "Left line 1", "Left line 2", "Left line 3", "Left line 4",
    "Right line 1", "Right line 2", "Right line 3", "Right line 4",
  ]);
});
test("PDF.js keeps indented paragraphs separate within the same column", () => {
  const page = extractPDFJSPage(0, 595, 790, [
    item("The first paragraph", 40, 740, 254),
    item("ends here.", 40, 729, 70),
    item("The second paragraph starts inside the margin", 57, 718, 237),
    item("and returns to the column edge.", 40, 707, 254),
  ]);
  assert.deepEqual(page.blocks.map(block => block.lineRects.length), [2, 2]);
});
test("PDF.js separates an unnumbered bold title and keeps a multiline figure legend intact", () => {
  const page = extractPDFJSPage(0, 595, 790, [
    { ...item("IVF outcomes among the four PCOS subtypes", 306, 350, 185), bold: true },
    item("There were 5,418 women in the cohort.", 306, 339, 250),
    { ...item("Fig. 2 | Classification and validation of PCOS subtypes.", 40, 120, 247), height: 7 },
    { ...item("Description of panel a and panel b.", 40, 110, 240), height: 7 },
    { ...item("Panel c compares the four subtypes.", 40, 100, 235), height: 7 },
  ]);
  assert.equal(page.blocks[0].type, "heading");
  assert.equal(page.blocks[0].text, "IVF outcomes among the four PCOS subtypes");
  assert.equal(page.blocks[1].type, "paragraph");
  assert.equal(page.blocks[2].type, "caption");
  assert.equal(page.blocks[2].lineRects.length, 3);
});
test("recovers uncovered body lines without resending neighboring translated text", () => {
  const page = extractPDFJSPage(0, 595, 790, [
    item("Already translated line of a paragraph.", 306, 410, 247),
    item("Regarding maternal complications, all women with PCOS exhib-", 306, 399, 247),
    item("ited an increased risk of moderate to severe ovarian hyperstimulation", 306, 388, 247),
  ]);
  const [block] = page.blocks;
  const [fragment] = uncoveredBlocks(block, [block.lineRects[0]]);
  assert.equal(fragment.lineRects.length, 2);
  assert.equal(fragment.bbox.top, block.lineRects[1].top);
  assert.match(fragment.text, /PCOS exhibited an increased risk/);
  assert.doesNotMatch(fragment.text, /Already translated/);
});
test("PDF.js page model carries page index, text and coordinate bounds", () => {
  const page = extractPDFJSPage(2, 612, 792, [
    item("2 METHODS", 40, 760, 150),
    item("The outcome", 40, 720, 180),
    item("was evaluated.", 40, 705, 190),
    item("Figure 1. Flowchart", 40, 670, 190),
  ]);
  assert.equal(page.index, 2);
  assert.equal(page.blocks[0].type, "heading");
  assert.equal(page.blocks[1].text, "The outcome was evaluated.");
  assert.equal(page.blocks[2].type, "caption");
  assert.equal(page.blocks[1].bbox.left, 40);
  assert.ok(page.blocks[1].bbox.top > page.blocks[1].bbox.bottom);
  assert.equal(page.blocks[1].lineRects.length, 2);
});
test("PDF.js model ignores empty and malformed glyph data", () => {
  const page = extractPDFJSPage(0, 595, 842, [
    item("   ", 40, 700),
    { str: "Missing transform", transform: [] },
    item("Valid text.", 50, 600),
  ]);
  assert.equal(page.blocks.length, 1);
  assert.equal(page.blocks[0].text, "Valid text.");
});
test("Docling output must contain valid page indices and sizes", () => {
  assert.throws(() => validateNativeDocument({ pages: [{index: 0, width: -10, height: 100}] }, "docling"));
  assert.throws(() => validateNativeDocument({ pages: null }, "docling"));
  const valid = validateNativeDocument({
    pages: [{ index: 0, width: 612, height: 792,
      blocks: [{ id: "docling:0:0", type: "caption", text: "Figure 1.",
        bbox: {left: 20, bottom: 20, right: 200, top: 40} }] }],
  }, "docling");
  assert.equal(valid.source, "docling");
  assert.equal(valid.pages[0].blocks[0].type, "caption");
});
test("native stacked HTML keeps searchable original and translated text and escapes input", () => {
  const html = buildNativeBilingualHTML([
    { pageIndex: 0,
      blocks: [{ block: { id: "b", pageIndex: 0, order: 0, type: "paragraph",
        source: "pdfjs", bbox: { left: 0, right: 1, bottom: 0, top: 1 },
        text: "<script>English & Chinese</script>" }, translation: "中文<安全>" }] },
  ], "A paper & B", "pdfjs");
  assert.doesNotMatch(html, /<img|original-page/u);
  assert.match(html, /page-break-after:always/u);
  assert.match(html, /data-parser="pdfjs"/u);
  assert.match(html, /&lt;script&gt;English &amp; Chinese&lt;\/script&gt;/u);
  assert.match(html, /中文&lt;安全&gt;/u);
  assert.doesNotMatch(html, /<script>/u);
});
