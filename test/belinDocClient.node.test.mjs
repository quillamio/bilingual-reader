import test from "node:test";
import assert from "node:assert/strict";
import { translateBelinPDF, belinData, belinDownloadURL, signedBelinURL, outputType, checkBelinPDF } from "../src/belinDocClient.ts";
const bytes = new TextEncoder().encode("%PDF-1.7\nsample\n%%EOF\n");
const wrap=data=>({code:"200",data});
function fixture({status=3,confirm=true,malformed=false}={}) {
  const calls=[];
  const request=async(method,url,headers,body,type)=>{
    calls.push({method,url,headers,body,type});
    if(method==="PUT") {assert.deepEqual(headers,{});return "";}
    if(method==="GET") {assert.deepEqual(headers,{});return malformed?new TextEncoder().encode("HTML error").buffer:bytes.buffer;}
    assert.equal(headers["X-Api-Key"],"ft_test");
    if(url.endsWith("getModelList"))return wrap([{version:"mock-model",coefficient:1}]);
    if(url.endsWith("getMyWalletInfo"))return wrap({translateQuota:100,totalFreeTranslateQuota:500,useFreeTranslateQuota:25});
    if(url.endsWith("getMySubscriptionInfo"))return wrap({uploadFileSize:30});
    if(url.endsWith("batchPresignedUploadUrl"))return wrap([{objectKey:"object",storageType:1,persignedUploadUrl:"https://example.s3.amazonaws.com/input?sig=secret"}]);
    if(url.endsWith("isOcr"))return wrap({isOcr:1,isDoubleDeck:0});
    if(url.endsWith("batchSubmitTranslateTask"))return wrap({batchNo:"batch"});
    if(url.endsWith("searchTranslateFileByBatchNo"))return wrap([{batchNo:"batch",sourceFileName:"document.pdf",status,translateOrderNo:"order"}]);
    if(url.endsWith("getTranslateS3DownloadUrl"))return 'event:[PROCESS]\ndata:\n\nevent:[DONE]\ndata:{"translateOrderNo":"order","url":"https://example.s3.amazonaws.com/output?sig=secret"}\n\n';
    throw Error("unexpected endpoint");
  };
  return {calls,request,options:{key:"ft_test",model:"mock-model",layout:"side-by-side",ocr:"auto",check:()=>{},wait:async()=>{},maxPolls:2,confirmSubmit:info=>{assert.equal(info.freePages,475);assert.equal(info.ocr,true);return confirm;}}};
}
test("full official sequence, correct OCR/math and side-by-side type; no key on storage",async()=>{
 const f=fixture();assert.deepEqual(await translateBelinPDF(f.request,bytes,f.options),bytes);
 const submits=f.calls.filter(x=>x.url.endsWith("batchSubmitTranslateTask"));assert.equal(submits.length,1);
 const data=JSON.parse(submits[0].body);assert.equal(data.isMath,1);assert.equal(data.isOcr,1);assert.equal(data.fileList[0].fileName,"document.pdf");
 assert.equal(JSON.parse(f.calls.find(x=>x.url.endsWith("getTranslateS3DownloadUrl")).body).urlType,3);
 assert.equal(outputType("stacked"),4);assert.equal(outputType("translation"),2);
});
test("submission refusal does not spend translation quota",async()=>{const f=fixture({confirm:false});assert.equal(await translateBelinPDF(f.request,bytes,f.options),undefined);assert.ok(!f.calls.some(x=>x.url.endsWith("batchSubmitTranslateTask")));});
test("failed or exhausted polling does not resubmit",async()=>{for(const status of [4,5,2]){const f=fixture({status});await assert.rejects(translateBelinPDF(f.request,bytes,f.options));assert.equal(f.calls.filter(x=>x.url.endsWith("batchSubmitTranslateTask")).length,1);}});
test("business auth errors sanitized",()=>{assert.throws(()=>belinData({code:"30306",msg:"secret"}),e=>e.message.includes("30306")&&!e.message.includes("secret"));});
test("SSE refuses missing DONE, wrong order and untrusted storage",()=>{assert.throws(()=>belinDownloadURL("event:[PROCESS]\ndata:{}", "order"));assert.throws(()=>belinDownloadURL('event:[DONE]\ndata:{"translateOrderNo":"other","url":"https://example.s3.amazonaws.com/a"}',"order"));for(const u of ["http://a.amazonaws.com/a","https://amazonaws.com.evil.test/a","https://127.0.0.1/a","https://user:pass@a.amazonaws.com/a"])assert.throws(()=>signedBelinURL(u));});
test("non-PDF downloads rejected",async()=>{const f=fixture({malformed:true});await assert.rejects(translateBelinPDF(f.request,bytes,f.options),/完整 PDF/);assert.throws(()=>checkBelinPDF(bytes.slice(0,-6)));});
test("invalid key and cancellation prevent all requests",async()=>{const f=fixture();await assert.rejects(translateBelinPDF(f.request,bytes,{...f.options,key:""}));await assert.rejects(translateBelinPDF(f.request,bytes,{...f.options,check:()=>{throw Error("cancelled");}}));assert.equal(f.calls.length,0);});

test("malicious signed URL never receives the source PDF or API key",async()=>{
 const f=fixture();let writes=0;
 const request=async(method,url,headers,body,type)=>{
   if(method==="PUT")writes++;
   if(url.endsWith("batchPresignedUploadUrl"))return wrap([{objectKey:"x",storageType:1,persignedUploadUrl:"https://evil.example/upload"}]);
   return f.request(method,url,headers,body,type);
 };
 await assert.rejects(translateBelinPDF(request,bytes,f.options),/存储地址/);assert.equal(writes,0);
});
