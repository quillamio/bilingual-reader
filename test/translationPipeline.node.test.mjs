import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBatchPayload,
  buildOpenAIRequestBody,
  extractOpenAIContent,
  formatOpenAIHttpError,
  getXhrResponseBody,
  normalizeChatCompletionsEndpoint,
  packBatchItems,
  parseBatchResult,
  splitTextForRequest,
} from "../src/translationPipeline.ts";
import { CancellationToken } from "../src/cancellationToken.ts";
import { planFigureBackfills } from "../src/figureBackfill.ts";

function block(type, text, pageRects, extra = {}) {
  return {
    type,
    anchor: { pageRects },
    content: text ? [{ text }] : [],
    ...extra,
  };
}

function structureWithContent(content, viewRect = [0, 0, 600, 800]) {
  return {
    catalog: { pages: [{ viewRect }] },
    content,
  };
}

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

test("normalizes common OpenAI-compatible endpoint forms", () => {
  assert.equal(
    normalizeChatCompletionsEndpoint("https://api-inference.modelscope.cn/v1"),
    "https://api-inference.modelscope.cn/v1/chat/completions",
  );
  assert.equal(
    normalizeChatCompletionsEndpoint("https://generativelanguage.googleapis.com/v1beta/openai/"),
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  );
  assert.equal(
    normalizeChatCompletionsEndpoint("https://example.com/v1/chat/completions"),
    "https://example.com/v1/chat/completions",
  );
  assert.equal(
    normalizeChatCompletionsEndpoint("https://example.com"),
    "https://example.com/v1/chat/completions",
  );
});

test("builds an OpenAI request body with system and user messages", () => {
  const body = buildOpenAIRequestBody({
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
    systemPrompt: "translate carefully",
    text: "hello",
    temperature: 0.2,
  });

  assert.equal(body.model, "deepseek-ai/DeepSeek-V4.1-Flash");
  assert.equal(body.temperature, 0.2);
  assert.deepEqual(body.messages, [
    { role: "system", content: "translate carefully" },
    { role: "user", content: "hello" },
  ]);
});

test("extracts assistant content from string and array responses", () => {
  assert.equal(
    extractOpenAIContent({ choices: [{ message: { content: "  译文  " } }] }),
    "译文",
  );
  assert.equal(
    extractOpenAIContent({
      choices: [{ message: { content: [{ text: "甲" }, { text: "乙" }] } }],
    }),
    "甲乙",
  );
  assert.equal(extractOpenAIContent({ choices: [] }), null);
});

test("formats provider error bodies into a readable message", () => {
  assert.match(
    formatOpenAIHttpError(402, '{"error":{"message":"credits depleted"}}'),
    /HTTP 402.*credits depleted/u,
  );
});

test("never reads responseText from a non-text XHR", () => {
  const xhr = {
    responseType: "json",
    response: { error: { message: "boom" } },
    get responseText() {
      throw new Error("responseText is only available if responseType is '' or 'text'");
    },
  };

  assert.deepEqual(getXhrResponseBody(xhr), { error: { message: "boom" } });
  assert.equal(
    getXhrResponseBody({ responseType: "text", responseText: '{"ok":true}' }),
    '{"ok":true}',
  );
});

test("plans a figure crop between the caption and the body above it", () => {
  const structure = structureWithContent([
    block("paragraph", "body text", [[0, 50, 600, 550, 650]]),
    block("caption", "Figure 1. A caption.", [[0, 50, 500, 550, 520]]),
  ]);

  const candidates = planFigureBackfills(structure);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].refPath, "1");
  assert.equal(candidates[0].pageIndex, 0);
  assert.deepEqual(candidates[0].rect, [44, 524, 556, 596]);
});

test("does not backfill when Zotero already emitted an image block", () => {
  const structure = structureWithContent([
    block("paragraph", "body text", [[0, 50, 600, 550, 650]]),
    block("image", "", [[0, 60, 530, 540, 590]]),
    block("caption", "Figure 1. A caption.", [[0, 50, 500, 550, 520]]),
  ]);

  assert.deepEqual(planFigureBackfills(structure), []);
});

test("rejects a region containing other text", () => {
  const structure = structureWithContent([
    block("paragraph", "body text", [[0, 50, 600, 550, 650]]),
    block("paragraph", "axis labels 1 2 3", [[0, 80, 540, 520, 580]]),
    block("caption", "Figure 1. A caption.", [[0, 50, 500, 550, 520]]),
  ]);

  assert.deepEqual(planFigureBackfills(structure), []);
});

test("ignores non-figure captions", () => {
  const structure = structureWithContent([
    block("paragraph", "body text", [[0, 50, 600, 550, 650]]),
    block("caption", "Table 1. A table.", [[0, 50, 500, 550, 520]]),
  ]);

  assert.deepEqual(planFigureBackfills(structure), []);
});

test("keeps the crop inside the caption column", () => {
  const structure = structureWithContent([
    block("paragraph", "left column above", [[0, 50, 600, 300, 650]]),
    block("paragraph", "right column above", [[0, 320, 600, 550, 650]]),
    block("caption", "Fig. 2. Column caption.", [[0, 50, 500, 300, 520]]),
  ]);

  const candidates = planFigureBackfills(structure);
  assert.equal(candidates.length, 1);
  assert.ok(candidates[0].rect[0] >= 44);
  assert.ok(candidates[0].rect[2] <= 306);
});

test("keeps side-by-side figure crops in separate columns", () => {
  const structure = structureWithContent([
    block("paragraph", "left body", [[0, 50, 400, 290, 500]]),
    block("paragraph", "right body", [[0, 310, 400, 550, 500]]),
    block("caption", "Figure 2. Left.", [[0, 50, 300, 290, 320]]),
    block("caption", "Figure 3. Right.", [[0, 310, 300, 550, 320]]),
  ]);

  const candidates = planFigureBackfills(structure);
  assert.equal(candidates.length, 2);
  const left = candidates.find((candidate) => candidate.rect[0] < 300);
  const right = candidates.find((candidate) => candidate.rect[0] >= 300);
  assert.ok(left && right);
  assert.ok(left.rect[2] < right.rect[0]);
  assert.ok(right.rect[2] <= 556);
});

test("a wide caption spanning both columns gets a full-width crop", () => {
  const structure = structureWithContent([
    block("paragraph", "left body", [[0, 50, 400, 290, 500]]),
    block("paragraph", "right body", [[0, 310, 400, 550, 500]]),
    block("caption", "Figure 4. Full width.", [[0, 50, 300, 550, 320]]),
  ]);

  const candidates = planFigureBackfills(structure);
  assert.equal(candidates.length, 1);
  assert.ok(candidates[0].rect[0] <= 44);
  assert.ok(candidates[0].rect[2] >= 556);
});

test("drops duplicate crops for the same figure region", () => {
  const structure = structureWithContent([
    block("paragraph", "body", [[0, 50, 600, 550, 650]]),
    block("caption", "Figure 5. First caption.", [[0, 50, 500, 550, 520]]),
    block("caption", "Figure 5. Continued caption.", [[0, 50, 500, 550, 520]]),
  ]);

  assert.equal(planFigureBackfills(structure).length, 1);
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
