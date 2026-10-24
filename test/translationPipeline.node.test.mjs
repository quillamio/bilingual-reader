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
