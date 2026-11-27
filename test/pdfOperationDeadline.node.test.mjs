import assert from "node:assert/strict";
import test from "node:test";
import { PDFOperationTimeoutError, withPDFOperationDeadline, writeTemporaryWithDeadline } from "../src/pdfOperationDeadline.ts";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test("stage deadline returns successful result and does not cancel later", async () => {
  let cancelled = 0;
  assert.equal(await withPDFOperationDeadline("render", 15, () => 42, () => cancelled++), 42);
  await delay(25);
  assert.equal(cancelled, 0);
});

test("hung operations reject with distinct stage names", async () => {
  for (const stage of ["PDF.js page", "PDF.js text", "render", "browser load", "translation", "file read", "file write"]) {
    await assert.rejects(withPDFOperationDeadline(stage, 5, () => new Promise(() => {})), error =>
      error instanceof PDFOperationTimeoutError && error.message.includes(stage));
  }
});

test("timeout cancels exactly once and observes late rejection", async () => {
  let rejectLate;
  let cancelled = 0;
  const pending = new Promise((_, reject) => { rejectLate = reject; });
  await assert.rejects(withPDFOperationDeadline("render", 5, () => pending, () => {
    cancelled++;
    throw new Error("cancel failure");
  }), PDFOperationTimeoutError);
  rejectLate(new Error("late render failure"));
  await delay(10);
  assert.equal(cancelled, 1);
});

test("original errors remain distinguishable from timeouts", async () => {
  const error = new Error("HTTP 429");
  await assert.rejects(withPDFOperationDeadline("translation", 100, () => { throw error; }), e => e === error);
  await assert.rejects(withPDFOperationDeadline("translation", 100, () => Promise.reject(error)), e => e === error);
});

test("successful temporary write is not removed", async () => {
  let removed = 0;
  await writeTemporaryWithDeadline("write", 50, async () => {}, () => removed++);
  assert.equal(removed, 0);
});

test("late temporary write is cleaned after it settles", async () => {
  let finish;
  let removed = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  await assert.rejects(writeTemporaryWithDeadline("write", 5, () => pending, () => removed++), PDFOperationTimeoutError);
  assert.equal(removed, 0);
  finish();
  await delay(10);
  assert.equal(removed, 1);
});

test("late failed temporary write is cleaned without unhandled rejection", async () => {
  let fail;
  let removed = 0;
  const pending = new Promise((_, reject) => { fail = reject; });
  await assert.rejects(writeTemporaryWithDeadline("write", 5, () => pending, () => removed++), PDFOperationTimeoutError);
  fail(new Error("disk error"));
  await delay(10);
  assert.equal(removed, 1);
});
