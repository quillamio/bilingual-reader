import assert from 'node:assert/strict';
import test from 'node:test';
import { translationQuality, scientificSpans } from '../src/scientificText.ts';
import { TranslationRouter, TranslationHTTPError, providerGroup } from '../src/translationRouter.ts';
import { TranslationCheckpoint, runParagraphPass } from '../src/translationCheckpoint.ts';
import { hasCompletePDFMarkers } from '../src/pdfExportUtils.ts';

test('Issue 33 JACC: clinical threshold direction survives translation', () => {
  const source = 'Risk increased with LDL-C <100 mg/dL.';
  assert.equal(translationQuality(source,'LDL-C ＜100 mg/dL 时风险升高。'),'valid');
  assert.equal(translationQuality(source,'LDL-C >100 mg/dL 时风险升高。'),'missing-scientific-token');
  assert.equal(translationQuality('Risk increased at ≥30 mg/dL.','风险在>=30 mg/dL 时升高。'),'valid');
});
test('Issue 33 JACC: equivalent confidence interval dashes accepted, changed endpoints rejected', () => {
  const source='Risk was 1.42 (95% CI: 1.32-1.52).';
  assert.equal(translationQuality(source,'风险为1.42（95% CI：1.32–1.52）。'),'valid');
  assert.equal(translationQuality(source,'风险为1.42（95% CI：1.32–1.53）。'),'missing-scientific-token');
});
test('Issue 33 XunZi abstract: case-sensitive mouse gene names protected', () => {
  assert.ok(scientificSpans('Chk2 was inhibited.').some(s=>s.text==='Chk2'));
  assert.equal(translationQuality('Chk2 was inhibited.','Chk2受到抑制。'),'valid');
  assert.equal(translationQuality('Chk2 was inhibited.','受到了抑制。'),'missing-scientific-token');
  assert.equal(translationQuality('CHK2 and IRAK4 were activated.','CHK2 和 IRAK4 被激活。'),'valid');
});
test('Issue 33: rate limited primary, partial checkpoint, resume only unfinished paragraphs', async () => {
  const router=new TranslationRouter(5,100,20);
  const values=new Map();const backend={read:k=>values.get(k),write:(k,v)=>values.set(k,v)};
  const items=['a','b','c','d'];let phase=1;const calls=[];
  let cp=new TranslationCheckpoint(backend,'fixture','route');
  const run=()=>runParagraphPass({items:items.filter(x=>cp.get(x,()=>true)?.state!=='done'),maxConsecutiveFailures:2,cancelled:()=>false,isCancellation:()=>false,
    translate:x=>router.translate({engines:['google','googleapi','bing'].map(id=>({id,group:providerGroup(id),gapMs:0})),timeoutMs:100,request:async id=>{calls.push([phase,id,x]);if(id==='google')throw new TranslationHTTPError(429,1000);if(phase===1&&x!=='a')throw Error('unavailable');return '译'+x;},validate:Boolean}),
    success:(x,text)=>cp.record(x,{text,tag:'bing'}),failure:x=>cp.record(x)});
  const first=await run();assert.equal(first.done,1);assert.equal(first.paused,true);
  cp=new TranslationCheckpoint(backend,'fixture','route');phase=2;await new Promise(r=>setTimeout(r,35));
  const second=await run();assert.equal(second.done,3);assert.equal(calls.filter(x=>x[1]==='google').length,1);assert.ok(calls.every(x=>x[1]!=='googleapi'));assert.ok(calls.filter(x=>x[0]===2).every(x=>x[2]!=='a'));
});
test('Issue 33 PDF integrity guard rejects truncated output',()=>{assert.equal(hasCompletePDFMarkers('%PDF-1.7','startxref\n12\n%%EOF\n'),true);assert.equal(hasCompletePDFMarkers('%PDF-1.7','startxref\n12\n%%EO'),false);});
