import assert from "node:assert/strict";
import test from "node:test";
import { PDFExportTask, PDFExportCancelledError } from "../src/pdfExportTask.ts";
import { withPDFOperationDeadline, waitForPDFExport, writeTemporaryWithDeadline } from "../src/pdfOperationDeadline.ts";
import { withPDFPrintDeadline } from "../src/pdfExportUtils.ts";

const turn = () => new Promise(resolve => setTimeout(resolve, 0));

test("cancel before starting does not call the operation", async () => {
  const task = new PDFExportTask();
  task.cancel();
  let started = 0;
  await assert.rejects(withPDFOperationDeadline("parse", 1000, () => ++started, undefined, task), PDFExportCancelledError);
  assert.equal(started, 0);
});

test("in-flight cancellation invokes render cancellation once and ignores late rejection", async () => {
  const task = new PDFExportTask();
  let fail;
  let aborted = 0;
  const pending = new Promise((_, reject) => { fail = reject; });
  const result = withPDFOperationDeadline("render", 1000, () => pending, () => aborted++, task);
  await turn();
  task.cancel();
  task.cancel();
  await assert.rejects(result, PDFExportCancelledError);
  fail(new Error("late rejection"));
  await turn();
  assert.equal(aborted, 1);
});

test("settled operations remove their cancellation listeners", async () => {
  const task = new PDFExportTask();
  let aborted = 0;
  assert.equal(await withPDFOperationDeadline("load", 1000, () => 7, () => aborted++, task), 7);
  task.cancel();
  assert.equal(aborted, 0);
});

test("cancel interrupts inter-request wait", async () => {
  const task = new PDFExportTask();
  const result = waitForPDFExport(60000, task);
  task.cancel();
  await assert.rejects(result, PDFExportCancelledError);
});

test("cancelled write cleans late output without proceeding to import", async () => {
  const task = new PDFExportTask();
  let finish;
  let cleaned = 0;
  let imported = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  const result = (async () => {
    await writeTemporaryWithDeadline("write", 1000, () => pending, () => cleaned++, task);
    task.beginImport();
    imported++;
  })();
  await turn();
  task.cancel();
  await assert.rejects(result, PDFExportCancelledError);
  finish();
  await turn();
  assert.equal(cleaned, 1);
  assert.equal(imported, 0);
});

test("cancelled print cleans late output", async () => {
  const task = new PDFExportTask();
  let finish;
  let cleaned = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  const result = withPDFPrintDeadline(() => pending, 1000, task, () => cleaned++);
  await turn();
  task.cancel();
  await assert.rejects(result, PDFExportCancelledError);
  finish();
  await turn();
  assert.equal(cleaned, 1);
});

test("cancel before import rejects; cancellation after import boundary does not interrupt transaction", () => {
  const cancelled = new PDFExportTask();
  cancelled.cancel();
  assert.throws(() => cancelled.beginImport(), PDFExportCancelledError);
  let notified = 0;
  const importing = new PDFExportTask(() => notified++);
  importing.beginImport();
  importing.cancel();
  assert.equal(importing.canCancel, false);
  assert.equal(importing.cancelled, false);
  assert.equal(notified, 1);
  assert.throws(() => importing.beginImport());
});

test("a broken listener does not prevent remaining cancellation callbacks", () => {
  const task = new PDFExportTask();
  let count = 0;
  task.onCancel(() => { throw new Error("broken listener"); });
  task.onCancel(() => count++);
  task.cancel();
  assert.equal(count, 1);
});

test("a detached button callback cannot interrupt the import boundary", () => {
  const task = new PDFExportTask(() => { throw new Error("reader closed"); });
  assert.doesNotThrow(() => task.beginImport());
  assert.equal(task.canCancel, false);
});
