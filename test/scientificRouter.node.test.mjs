import assert from "node:assert/strict";
import test from "node:test";
import { translateScientificRequest } from "../src/scientificText.ts";
import { TranslationRouter, TranslationHTTPError, providerGroup } from "../src/translationRouter.ts";
const engines = (...ids) => ids.map(id => ({ id, group: providerGroup(id), gapMs: 0 }));
function routeWith(router, ids, mock) {
  return (payload, accept) => router.translate({
    engines: engines(...ids), timeoutMs: 150,
    request: id => mock(id, payload),
    validate: response => {
      const checked = accept(response.text);
      if (checked === undefined) return false;
      response.text = checked;
      return true;
    },
  });
}
test("protected retry uses the same scheduler and preserves real provider provenance", async () => {
  const router = new TranslationRouter(5, 60, 30);
  const calls = [];
  const route = routeWith(router, ["google", "googleapi", "bing"], async (id, payload) => {
    calls.push([id,payload]);
    if (id === "google") throw new TranslationHTTPError(429, 1000);
    const result = payload.includes("BRSCI_") ? payload.replace(" expression increased.", "表达升高。") : "表达升高。";
    return { text: result, engineTag: id };
  });
  const result = await translateScientificRequest("FBN1 expression increased.", route, 200);
  assert.deepEqual(calls.map(c=>c[0]),["google","bing","bing"]);
  assert.equal(result.text,"FBN1表达升高。");
  assert.equal(result.engineTag,"bing");
});
test("all providers rate-limited do not trigger scientific protection retries", async () => {
  const router = new TranslationRouter(5, 60, 30);
  const calls = [];
  const route = routeWith(router,["google","googleapi","bing"],async (id,payload)=>{calls.push([id,payload]);throw new TranslationHTTPError(429,1000);});
  await assert.rejects(translateScientificRequest("TP53 expression increased.",route,200),/HTTP 429/);
  assert.deepEqual(calls.map(c=>c[0]),["google","bing"]);
});
test("successful literal preservation uses a single request and never sends markers", async () => {
  const router=new TranslationRouter(); let count=0;
  const route=routeWith(router,["bing"],async (_id,payload)=>{count++;assert.doesNotMatch(payload,/BRSCI_/);return {text:"FBN1 表达升高。",engineTag:"bing"};});
  assert.equal((await translateScientificRequest("FBN1 expression increased.",route,200)).text,"FBN1 表达升高。");
  assert.equal(count,1);
});
