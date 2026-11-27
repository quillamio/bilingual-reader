import assert from "node:assert/strict";
import test from "node:test";
import { scientificSpans, isScientificPreserveOnly, translationQuality, validScientificTranslation, protectScientificText, splitScientificText, translateScientificRequest } from "../src/scientificText.ts";

test("recognized identifiers and statistics are preserved locally", () => {
  for (const s of ["FBN1 NOTCH2NLC C5b-9 NSAD 6MWT", "HR = 3.28 (95% CI, 1.70–6.35; P = 0.002)", "4 μM", "y = mx + b", "FBN1 c.123A>G [1–3]", "HLA-B*57:01", "rs12345", "mRNA", "-2.0", "[1, 2, 3]"]) {
    assert.equal(isScientificPreserveOnly(s), true, s);
    assert.equal(translationQuality(s,s), "preserved", s);
  }
});
test("ordinary headings, disease and drug names still need translation", () => {
  for (const s of ["Results", "AGE", "Age", "Cardiovascular disease", "eculizumab", "XunZi, an AI biologist, reveals disease-modifying targets", "We studied FBN1 and TP53."]) {
    assert.equal(isScientificPreserveOnly(s), false, s);
    assert.equal(translationQuality(s,s), "untranslated", s);
  }
});
test("short and altered English are not mistaken for Chinese translations", () => {
  assert.equal(translationQuality("Methods", "Methods"), "untranslated");
  assert.equal(translationQuality("Methods", "METHODS."), "untranslated");
  assert.equal(translationQuality("The treatment significantly improved motor function in the study cohort", "中 The treatment significantly improved motor function in the study cohort"), "untranslated");
  assert.equal(translationQuality("Methods", "方法"), "valid");
});
test("medical prose permits original gene and protein names", () => {
  assert.equal(translationQuality("FBN1 and TP53 expression increased.", "FBN1 和 TP53 的表达升高。"), "valid");
  assert.equal(translationQuality("FBN1 and TP53 expression increased.", "FBN1 的表达升高。"), "missing-scientific-token");
});
test("preserve P values, hazard ratios, interval endpoints and units", () => {
  const source = "Risk increased (HR = 3.28; 95% CI, 1.70–6.35; P < .001). Dose was 4 μM.";
  const target = "风险升高（HR = 3.28；95% CI，1.70–6.35；P < .001）。剂量为4 μM。";
  assert.equal(translationQuality(source, target), "valid");
  for (const bad of [target.replace("3.28", "3.82"), target.replace("P <", "P >"), target.replace("6.35", "6.53"), target.replace("4 μM", "4 mM")]) assert.equal(translationQuality(source,bad), "missing-scientific-token");
});
test("minus signs, scientific notation and repeats cannot disappear", () => {
  const source = "Values were −2.0, 1.2e-5 and −2.0.";
  assert.equal(translationQuality(source, "数值为-2.0、1.2e-5 和 -2.0。"), "valid");
  assert.equal(translationQuality(source, "数值为2.0、1.2e-5 和 -2.0。"), "missing-scientific-token");
  assert.equal(translationQuality(source, "数值为-2.0 和 1.2e-5。"), "missing-scientific-token");
});
test("references and variants are protected without preserving the entire prose", () => {
  const source = "The c.123A>G variant was reported (Smith et al., 2021) [1–3].";
  assert.equal(isScientificPreserveOnly(source), false);
  assert.equal(translationQuality(source, "报道了c.123A>G变异 (Smith et al., 2021) [1–3]。"), "valid");
  assert.equal(translationQuality(source, "报道了c.123A>G变异 (Smith et al., 2021) [1]。"), "missing-scientific-token");
  assert.ok(scientificSpans("See DOI 10.1000/example. This was reported.").some(s=>s.text === "10.1000/example"));
});
test("math delimiters and Greek symbols are kept", () => {
  const source = "The model uses $x^2+y^2=1$ and β.";
  assert.equal(translationQuality(source,"模型使用$x^2+y^2=1$和β。"),"valid");
  assert.equal(translationQuality(source,"模型使用$x^2+y^2=2$和β。"),"missing-scientific-token");
});
test("placeholder round trip and strict missing/duplicate detection", () => {
  const source = "FBN1 increased by 4 μM [1].";
  const p = protectScientificText(source);
  assert.equal(p.restore(p.text), source);
  const marker = p.text.match(/\[\[BRSCI_\d{4}\]\]/u)[0];
  assert.equal(p.restore(p.text.replace(marker,"")),undefined);
  assert.equal(p.restore(p.text+marker),undefined);
  assert.equal(translationQuality(source, p.text), "unresolved-marker");
});
test("existing placeholder-like input cannot collide", () => {
  const p = protectScientificText("BRSCI is a literal and FBN1 was found.");
  assert.match(p.text,/BRSCI0_/u);
  assert.equal(p.restore(p.text),"BRSCI is a literal and FBN1 was found.");
});
test("splitting never splits decimal, citation or gene identifiers", () => {
  const s = "Treatment increased 3.28 mg/kg and FBN1 expression [1–3]. Other results followed.";
  const parts = splitScientificText(s, 25);
  assert.ok(parts.every(p=>p.length<=25));
  for (const span of scientificSpans(s)) assert.ok(parts.some(p=>p.includes(span.text)),span.text);
  assert.equal(parts.join(" "),s);
});
test("oversized indivisible identifier fails instead of corrupting it", () => {
  assert.throws(()=>splitScientificText("https://example.org/longidentifier",10),/科学标识/);
});
test("service errors and missing markers are not valid translations", () => {
  for (const s of ["", "HTTP 429", "[请求错误]", "翻译失败：超时", "[[BRSCI_0000]]"]) assert.equal(validScientificTranslation("Treatment",s),false);
});

test("pure scientific text bypasses the network", async () => {
  const r = await translateScientificRequest("FBN1 DMD FSHD CVD", async () => { throw new Error("must not call"); }, 200);
  assert.equal(r.text,"FBN1 DMD FSHD CVD");
  assert.equal(r.engineTag,"scientific:preserved");
});
test("missing scientific token triggers one protected retry, retaining actual provider", async () => {
  const calls=[];
  const r=await translateScientificRequest("FBN1 expression increased.",async (payload,accept)=>{
    calls.push(payload);
    const output=calls.length===1?"表达升高。":payload.replace(" expression increased.","表达升高。");
    const text=accept(output);
    if(text===undefined) throw new Error("invalid output");
    return {text,engineTag:"builtin:bing"};
  },200);
  assert.equal(calls.length,2); assert.match(calls[1],/BRSCI_/u);
  assert.equal(r.text,"FBN1表达升高。"); assert.equal(r.engineTag,"builtin:bing");
});
test("network failure does not cause a protected retry", async () => {
  let calls=0;
  await assert.rejects(translateScientificRequest("FBN1 expression increased.",async()=>{calls++;throw new Error("HTTP 429");},200),/429/);
  assert.equal(calls,1);
});
test("protected retry cannot exceed character limit or survive cancellation", async () => {
  let calls=0;
  const request=async (_payload,accept)=>{calls++;accept("表达升高。");throw new Error("invalid");};
  await assert.rejects(translateScientificRequest("FBN1 increased.",request,15),/invalid/);
  assert.equal(calls,1);
  await assert.rejects(translateScientificRequest("FBN1 increased.",request,100,()=>true),/取消/);
  assert.equal(calls,1);
});
