import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBatchPayload,
  packBatchItems,
  parseBatchResult,
  splitTextForRequest,
} from "../src/translationPipeline.ts";
import { CancellationToken } from "../src/cancellationToken.ts";

test("splits long text without exceeding the request limit", () => {
  const chunks = splitTextForRequest(
    "First sentence is short. Second sentence is also short. Third sentence is longer.",
    35,
  );

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 35));
  assert.match(chunks.join(" "), /First sentence/);
});

test("packs multiple short paragraphs under both limits", () => {
  const items = [
    { id: "a", text: "Alpha paragraph." },
    { id: "b", text: "Beta paragraph." },
    { id: "c", text: "Gamma paragraph." },
  ];
  const batches = packBatchItems(items, 80, 2);

  assert.deepEqual(
    batches.map((batch) => batch.map((item) => item.id)),
    [["a", "b"], ["c"]],
  );
  assert.ok(batches.every((batch) => buildBatchPayload(batch).length <= 80));
});

test("parses a marker-preserving batch", () => {
  const translated = "[[BRSEG_0000]]\n甲段。\n\n[[BRSEG_0001]]\n乙段。";
  assert.deepEqual(parseBatchResult(translated, 2), ["甲段。", "乙段。"]);
});

test("rejects a malformed batch so callers can safely retry individually", () => {
  assert.equal(parseBatchResult("甲段。\n\n乙段。", 2), null);
  assert.equal(parseBatchResult("[[BRSEG_0001]]\n乙段。", 1), null);
  assert.equal(parseBatchResult("[[BRSEG_0000]]\n", 1), null);
});

test("cancellation listeners run once and can be detached", () => {
  const token = new CancellationToken();
  let activeCalls = 0;
  let detachedCalls = 0;

  token.onCancel(() => {
    activeCalls += 1;
  });
  const detach = token.onCancel(() => {
    detachedCalls += 1;
  });
  detach();

  token.cancel();
  token.cancel();

  assert.equal(token.cancelled, true);
  assert.equal(activeCalls, 1);
  assert.equal(detachedCalls, 0);
});
