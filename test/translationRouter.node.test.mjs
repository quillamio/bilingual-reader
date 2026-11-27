import assert from "node:assert/strict";
import test from "node:test";
import { TranslationRouter, TranslationHTTPError, TranslationCancelledError, parseRetryAfter, translationHTTPError, normalizeFallbackOrder, providerGroup } from "../src/translationRouter.ts";
const engines = (...ids) => ids.map(id => ({ id, group: providerGroup(id), gapMs: 0 }));
const run = (router, ids, request, extra = {}) => router.translate({ engines: engines(...ids), timeoutMs: 150, request, validate: value => Boolean(value), ...extra });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function token() {
  const callbacks = new Set();
  return { cancelled: false, onCancel(fn) { callbacks.add(fn); return () => callbacks.delete(fn); }, cancel() { this.cancelled = true; for (const fn of callbacks) fn(); } };
}
test("Retry-After seconds, HTTP date and malformed values", () => {
  assert.equal(parseRetryAfter("45"), 45000);
  assert.equal(parseRetryAfter("Thu, 01 Jan 1970 00:01:00 GMT", 1000), 59000);
  assert.equal(parseRetryAfter("bad"), 0);
});
test("Zotero HTTP wrapper preserves status and Retry-After without exposing URL", () => {
  const e = translationHTTPError({ message: "secret URL", xmlhttp: { status: 429, getResponseHeader: () => "120" } });
  assert.equal(e.status, 429); assert.equal(e.retryAfterMs, 120000); assert.doesNotMatch(e.message, /secret/);
  assert.equal(translationHTTPError(new Error("HTTP 503")).status, 503);
  assert.equal(translationHTTPError({status: 429, response: {error: "rate limit"}, getResponseHeader: () => "90"}).retryAfterMs, 90000);
});
test("free fallback allowlist deduplicates and excludes billed/local services", () => {
  assert.deepEqual(normalizeFallbackOrder("bing,google, bing，openai ollama azure deeplx youdao"), ["bing", "google", "youdao"]);
});
test("429 skips both Google endpoints and honors cooldown across jobs", async () => {
  const router = new TranslationRouter(5, 50, 20), calls = [];
  const request = async id => { calls.push(id); if (id === "google") throw new TranslationHTTPError(429, 200); return "译文"; };
  assert.equal(await run(router, ["google", "googleapi", "bing"], request), "译文");
  await run(router, ["googleapi", "bing"], request);
  assert.deepEqual(calls, ["google", "bing", "bing"]);
});
test("fallback respects configured order and invalid output triggers switch", async () => {
  const calls = []; const router = new TranslationRouter(5, 50, 20);
  await run(router, ["bing", "youdao", "google"], async id => { calls.push(id); return id === "youdao" ? "译文" : ""; });
  assert.deepEqual(calls, ["bing", "youdao"]);
});
test("transient 503 gets bounded retry with delay", async () => {
  const times = []; const router = new TranslationRouter(20, 50, 30);
  await run(router, ["bing"], async () => { times.push(Date.now()); if (times.length === 1) throw new TranslationHTTPError(503); return "译文"; });
  assert.equal(times.length, 2); assert.ok(times[1] - times[0] >= 18);
});
test("503 Retry-After prevents immediate retry", async () => {
  let calls = 0; const router = new TranslationRouter(5, 50, 20);
  await assert.rejects(run(router, ["bing"], async () => { calls++; throw new TranslationHTTPError(503, 500); }), /HTTP 503/);
  await assert.rejects(run(router, ["bing"], async () => { calls++; return "译文"; }), /冷却/);
  assert.equal(calls, 1);
});
test("circuit opens after two failures and recovers after cooldown", async () => {
  const router = new TranslationRouter(5, 50, 25); let calls = 0;
  const fail = async () => { calls++; throw new Error("bad"); };
  await assert.rejects(run(router, ["bing"], fail)); await assert.rejects(run(router, ["bing"], fail));
  await assert.rejects(run(router, ["bing"], fail), /冷却/); assert.equal(calls, 2);
  await sleep(35); assert.equal(await run(router, ["bing"], async () => "译文"), "译文");
});
test("same provider serializes requests and respects spacing", async () => {
  const router = new TranslationRouter(); let inFlight = 0, peak = 0; const times = [];
  const request = async () => { times.push(Date.now()); peak = Math.max(peak, ++inFlight); await sleep(10); inFlight--; return "译文"; };
  await Promise.all([1,2,3].map(() => run(router, ["google"], request, { timeoutMs: 500, engines: [{id:"google",group:"google",gapMs:25}] })));
  assert.equal(peak, 1); assert.ok(times[1]-times[0]>=23 && times[2]-times[1]>=23);
});
test("different providers can operate concurrently", async () => {
  const router = new TranslationRouter(); let n = 0, peak = 0;
  const request = async () => { peak = Math.max(peak, ++n); await sleep(20); n--; return "译文"; };
  await Promise.all([run(router,["bing"],request),run(router,["youdao"],request)]); assert.equal(peak,2);
});
test("timeout switches provider without releasing still-running request", async () => {
  const router = new TranslationRouter(5, 30, 20); let finish; let calls = 0;
  const hung = new Promise(resolve => { finish = resolve; });
  assert.equal(await run(router,["bing","youdao"], async id => { if(id === "bing") { calls++; return hung; } return "译文"; }, {timeoutMs: 15}), "译文");
  await sleep(25); await assert.rejects(run(router,["bing"],async () => { calls++; return "译文"; },{timeoutMs:15})); assert.equal(calls,1);
  finish("late"); await sleep(25); assert.equal(await run(router,["bing"],async () => "译文"),"译文");
});
test("cancellation forbids fallback and late 429 still cools the provider", async () => {
  const router = new TranslationRouter(5, 30, 20), cancellation = token(); let rejectLate; const calls = [];
  const pending = new Promise((_,reject) => { rejectLate=reject; });
  const result = run(router,["google","bing"],async id => { calls.push(id); return pending; },{cancellation});
  await sleep(5); cancellation.cancel(); await assert.rejects(result,TranslationCancelledError); rejectLate(new TranslationHTTPError(429,100)); await sleep(5);
  await assert.rejects(run(router,["googleapi"],async id => {calls.push(id); return "译文";}),/冷却/); assert.deepEqual(calls,["google"]);
});
test("all failed produces sanitized diagnostics, no forced fallback", async () => {
  const router = new TranslationRouter(); await assert.rejects(run(router,["bing"],async () => {throw new Error("secret key PDF content");}),e => /bing/.test(e.message) && !/secret/.test(e.message));
});
