import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { composeSideBySidePDF } from "../src/pdfVectorExport.ts";
import { hasCompletePDFMarkers } from "../src/pdfExportUtils.ts";
import { PDFExportTask, PDFExportCancelledError } from "../src/pdfExportTask.ts";

async function makePDF(count) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < count; i++) pdf.addPage([300, 400]).drawText("Synthetic page " + (i + 1), { x: 24, y: 300, size: 12 });
  return pdf.save();
}
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
async function verifyPair(original, count) {
  const before = digest(original);
  const transcript = await makePDF(1), overflow = await makePDF(2);
  async function* pages() {
    for (let i = 0; i < count; i++) yield { pageIndex: i, bytes: i === 1 ? undefined : transcript, continuation: i === 0 ? overflow : undefined };
  }
  const output = await composeSideBySidePDF(original, pages(), count);
  const header = Buffer.from(output.slice(0, 32)).toString("latin1");
  const tail = Buffer.from(output.slice(-1024)).toString("latin1");
  assert.ok(hasCompletePDFMarkers(header, tail));
  const doc = await PDFDocument.load(output);
  assert.equal(doc.getPageCount(), count + 2);
  assert.ok(doc.getPages().every(p => p.getWidth() > p.getHeight()));
  assert.equal(digest(original), before);
}
test("Issue 33: actual pdf-lib composition, 12 pages, missing and overflow translations", async () => {
  await verifyPair(await makePDF(12), 12);
});
test("Issue 33: reject missing page, wrong page order and cancelled composition", async () => {
  const original = await makePDF(2);
  async function* missing() { yield { pageIndex: 0 }; }
  async function* unordered() { yield { pageIndex: 1 }; }
  await assert.rejects(composeSideBySidePDF(original, missing(), 2), /未全部配对/);
  await assert.rejects(composeSideBySidePDF(original, unordered(), 2), /顺序错误/);
  const task = new PDFExportTask(); task.cancel();
  await assert.rejects(composeSideBySidePDF(original, missing(), 2, task), PDFExportCancelledError);
});
// Publishers' PDFs are never committed to the public repository. Run locally with authorized copies.
for (const [label, path, expected] of [["JACC", process.env.BR_ISSUE33_JACC_PDF, 12], ["XunZi", process.env.BR_ISSUE33_XUNZI_PDF, undefined]]) {
  test("Issue 33: actual source PDF composition with synthetic transcripts: " + label, { skip: !path }, async () => {
    const bytes = await readFile(path);
    const count = (await PDFDocument.load(bytes)).getPageCount();
    if (expected !== undefined) assert.equal(count, expected);
    await verifyPair(bytes, count);
  });
}
