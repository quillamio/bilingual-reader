import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";
import { normalizeMinerU, normalizeMarkdownPages } from "../src/pdfCloudModel.ts";
import { combinePDFPages } from "../src/pdfVectorExport.ts";
import { buildNativeBilingualHTML } from "../src/pdfNativeHtml.ts";
import { configureBilingualPDFPrintSettings } from "../src/pdfExportUtils.ts";

function base() {
  return { source: "pdfjs", warnings: [], pages: [0, 1].map(index => ({
    index, width: 600, height: 800, blocks: [{
      id: "fallback-" + index, pageIndex: index, order: 0, source: "pdfjs",
      type: "paragraph", text: "PDF.js page " + index,
      bbox: {left: 0, bottom: 0, right: 600, top: 800},
    }],
  })) };
}
test("MinerU preserves physical pages and figure captions, with fallback on missing page", () => {
  const doc = normalizeMinerU(base(), [
    {page_idx: 0, type: "text", text: "Results", text_level: 1},
    {page_idx: 0, type: "image", img_caption: ["Figure 1. Muscle MRI"], img_path: "images/a.jpg"},
    {page_idx: 0, type: "table", table_body: "<table><tr><td>42</td></tr></table>"},
  ]);
  assert.equal(doc.pages.length, 2);
  assert.equal(doc.pages[0].blocks[1].text, "Figure 1. Muscle MRI");
  assert.equal(doc.pages[0].blocks[2].type, "table");
  assert.equal(doc.pages[1].blocks[0].source, "pdfjs");
  assert.ok(doc.warnings.length);
  assert.throws(() => normalizeMinerU(base(), [{page_idx: 3, text: "invalid"}]));
});
test("Mistral and LlamaParse use distinct page conventions and never fetch image links", () => {
  const first = normalizeMarkdownPages(base(), "mistral", [
    { index: 0, markdown: "# Results\n\n![img-0.jpeg](https://invalid.test/image.jpg)\n\nFigure 1. Outcome"},
    { index: 1, markdown: "Final paragraph." },
  ]);
  assert.deepEqual(first.pages[0].blocks.map(b => b.text), ["Results", "Figure 1. Outcome"]);
  const second = normalizeMarkdownPages(base(), "llamaparse", [
    { page_number: 1, success: true, markdown: "First" },
    { page_number: 2, success: false },
  ]);
  assert.equal(second.pages[0].blocks[0].text, "First");
  assert.equal(second.pages[1].blocks[0].text, "PDF.js page 1");
  assert.throws(() => normalizeMarkdownPages(base(), "mistral", [
    {index: 0, markdown: "duplicate"}, {index: 0, markdown: "duplicate"},
  ]));
  assert.throws(() => normalizeMarkdownPages(base(), "llamaparse", [{page_number: 0, markdown: "invalid"}]));
});
test("transcript-only mode does not require any JPEG and flows vertically", () => {
  const doc = base();
  const html = buildNativeBilingualHTML(doc.pages.map(page => ({
    pageIndex: page.index, image: "", blocks: page.blocks.map(block => ({block, translation: "中文"})),
  })), "Bilingual", "mineru", true);
  assert.doesNotMatch(html, /<img alt=/);
  assert.match(html, /data-parser="mineru"/);
  assert.match(html, /margin:16mm 17mm 20mm/);
  assert.match(html, /overflow:visible/);
});
test("A4 printing resets saved printer paper dimensions and vertical offsets", () => {
  const settings = { paperSizeUnit: 0, paperWidth: 8.5, paperHeight: 11,
    orientation: 1, unwriteableMarginBottom: 0.5, edgeBottom: 0.5 };
  configureBilingualPDFPrintSettings(settings);
  assert.equal(settings.paperWidth, 210);
  assert.equal(settings.paperHeight, 297);
  assert.equal(settings.paperSizeUnit, 1);
  assert.equal(settings.orientation, 0);
  assert.equal(settings.unwriteableMarginBottom, 0);
  assert.equal(settings.edgeBottom, 0);
});
test("real PDF bytes preserve original page dimensions, rotation, image resources and vector content", async () => {
  const original = await PDFDocument.create();
  const page = original.addPage([612, 792]);
  page.setRotation(degrees(90));
  const font = await original.embedFont(StandardFonts.Helvetica);
  page.drawText("Original vector text", {x: 20, y: 40, font, size: 12});
  page.drawRectangle({x: 30, y: 50, width: 80, height: 50, color: rgb(0, 0, 1)});
  const png = await original.embedPng("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=");
  page.drawImage(png, {x: 50, y: 100, width: 25, height: 25});
  original.addPage([595, 842]);
  const translation = await PDFDocument.create();
  translation.addPage([595, 842]);
  const source = await original.save(), transcript = await translation.save();
  const combined = await PDFDocument.load(await combinePDFPages(source, transcript, true, 2));
  assert.equal(combined.getPageCount(), 3);
  const preserved = combined.getPage(0);
  assert.deepEqual(preserved.getSize(), {width: 612, height: 792});
  assert.equal(preserved.getRotation().angle, 90);
  assert.ok(preserved.node.Resources().lookupMaybe(
    // PDFName imported dynamically below to keep all assertions on real PDF objects.
    (await import("pdf-lib")).PDFName.of("XObject"),
    (await import("pdf-lib")).PDFDict,
  ));
  const reversed = await PDFDocument.load(await combinePDFPages(source, transcript, false));
  assert.deepEqual(reversed.getPage(1).getSize(), {width: 612, height: 792});
  await assert.rejects(() => combinePDFPages(source, transcript, true, 3), /页数/);
});
