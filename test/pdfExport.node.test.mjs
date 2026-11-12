import assert from "node:assert/strict";
import test from "node:test";
import {
  hasCompletePDFMarkers,
  sanitizeExportFileBaseName,
} from "../src/pdfExportUtils.ts";

test("short titles and existing suffixes", () => {
  assert.equal(sanitizeExportFileBaseName("Paper - 中英对照翻译"), "Paper - 中英对照翻译");
  assert.equal(sanitizeExportFileBaseName("Paper.pdf"), "Paper");
  assert.equal(sanitizeExportFileBaseName("Paper.PDF"), "Paper");
});

test("long filenames are truncated by UTF-8 bytes; Zotero supplies .pdf", () => {
  const name = sanitizeExportFileBaseName("A".repeat(300) + " - 中英对照翻译.pdf");
  assert.equal(name.length, 180);
  assert.ok(!name.toLowerCase().endsWith(".pdf"));
  assert.ok(Buffer.byteLength(name, "utf8") <= 180);
});

test("Chinese and emoji names are not split", () => {
  const name = sanitizeExportFileBaseName("临床研究🧬".repeat(80));
  assert.ok(Buffer.byteLength(name, "utf8") <= 180);
  assert.doesNotMatch(name, /\uFFFD/);
});

test("Windows filename characters, trailing dots, and device names", () => {
  assert.equal(sanitizeExportFileBaseName('A\\B/C:D*E?F"G<H>I|J. '), "A_B_C_D_E_F_G_H_I_J");
  assert.equal(sanitizeExportFileBaseName("CON"), "_CON");
  assert.equal(sanitizeExportFileBaseName("lpt9"), "_lpt9");
  assert.equal(sanitizeExportFileBaseName("   "), "中英对照翻译");
  assert.equal(sanitizeExportFileBaseName("A\u0000B"), "A_B");
});

test("recognizes complete PDF header and EOF markers", () => {
  assert.equal(hasCompletePDFMarkers("%PDF-1.7\n", "startxref\n123\n%%EOF\n"), true);
  assert.equal(hasCompletePDFMarkers("%PDF-2.0\r", "%%EOF\r\n"), true);
  assert.equal(hasCompletePDFMarkers("%PDF-1.7", "%%EOF\u0000\n"), true);
});

test("rejects HTML, missing EOF, and partially written output", () => {
  assert.equal(hasCompletePDFMarkers("<html>", "%%EOF\n"), false);
  assert.equal(hasCompletePDFMarkers("%PDF-1.7\n", "partial output"), false);
  assert.equal(hasCompletePDFMarkers("%PDF-1.7\n", "%%EOF\ntruncated"), false);
});
