import test from "node:test";
import assert from "node:assert/strict";
import {parsePaddlePDF,paddleMultipart,paddleJSONL,paddleResultURL,paddleRect,normalizePaddlePages,PADDLE_JOBS} from "../src/paddleOCRClient.ts";
const rect={left:20,bottom:700,right:280,top:720};
const base={source:"pdfjs",warnings:[],pages:[{index:0,width:600,height:800,layout:{width:600,height:800,transform:[1,0,0,-1,0,800]},blocks:[{id:"p",pageIndex:0,order:0,type:"paragraph",source:"pdfjs",text:"A medical result.",bbox:rect,lineRects:[rect],lineTexts:["A medical result."]}]}]};
const region={block_label:"text",block_content:"A medical result.",block_bbox:[40,150,570,210]};
const row={width:1200,height:1600,parsing_res_list:[region,{block_label:"image",block_content:"",block_bbox:[40,400,560,700]}]};
const jsonl=JSON.stringify({result:{layoutParsingResults:[{prunedResult:row,markdown:{text:"unused",images:{x:"https://evil.invalid/image"}}}]}})+"\n";
const bytes=new TextEncoder().encode("%PDF-1.7\nsample\n%%EOF");
const control={check(){},wait:async()=>{},maxPolls:3};
test("official asynchronous flow submits once, sends no credential to BOS, preserves region geometry",async()=>{
 const calls=[];let polls=0;
 const request=async(method,url,headers,body)=>{
 calls.push({method,url,headers,body});
 if(method==="POST"){assert.equal(url,PADDLE_JOBS);assert.equal(headers.Authorization,"Bearer private");assert.ok(new TextDecoder().decode(body).includes("PaddleOCR-VL-1.6"));return JSON.stringify({code:0,data:{jobId:"ocrjob-test"}});}
 if(url===PADDLE_JOBS+"/ocrjob-test"){assert.equal(headers.Authorization,"Bearer private");return JSON.stringify({code:0,data:{jobId:"ocrjob-test",state:++polls===1?"running":"done",resultUrl:{jsonUrl:"https://test.bj.bcebos.com/result?sig=secret"}}});}
 assert.deepEqual(headers,{});assert.equal(url,"https://test.bj.bcebos.com/result?sig=secret");return jsonl;
 };
 const result=await parsePaddlePDF(request,bytes,"private","PaddleOCR-VL-1.6",base,control);
 assert.equal(result.source,"paddleocr");assert.deepEqual(result.pages[0].blocks[0].lineRects,[rect]);assert.equal(result.pages[0].blocks[1].type,"picture");assert.equal(calls.filter(x=>x.method==="POST").length,1);assert.equal(calls.length,4);
});
test("both models use independent official names and disable coordinate-changing preprocessing",()=>{
 for(const model of ["PaddleOCR-VL-1.6","PP-StructureV3"]){const form=new TextDecoder().decode(paddleMultipart(bytes,model,"Boundary123456"));assert.ok(form.includes(model));assert.ok(form.includes('"useDocOrientationClassify":false'));assert.ok(form.includes('"useDocUnwarping":false'));assert.ok(form.includes('filename="document.pdf"'));}
 assert.throws(()=>paddleMultipart(bytes,"paid-other","Boundary123456"));
});
test("geometry respects crop offsets and rotated page transform",()=>{
 const rotated={...base.pages[0],width:600,height:800,layout:{width:800,height:600,transform:[0,1,1,0,-20,-10]}};
 assert.deepEqual(paddleRect(rotated,[0,0,200,100],800,600),{left:10,right:110,bottom:20,top:220});
 assert.equal(paddleRect(rotated,[0,0,200,100],600,800),undefined);
});
test("protected artwork and OCR differences cannot be masked; table is preserved",()=>{
 const altered={...row,parsing_res_list:[region,{block_label:"table",block_content:"<table>secret</table>",block_bbox:region.block_bbox}]};
 const result=normalizePaddlePages(base,[altered]);assert.equal(result.pages[0].blocks[0].lineRects,undefined);assert.equal(result.pages[0].blocks[1].type,"picture");assert.ok(result.warnings.some(x=>x.includes("续页")));
 const mismatch=normalizePaddlePages(base,[{...row,parsing_res_list:[{...region,block_content:"Different medical result."}]}]);assert.equal(mismatch.pages[0].blocks[0].lineRects,undefined);
 const malformed=normalizePaddlePages(base,[{...row,parsing_res_list:[region,{block_label:"formula",block_bbox:[0,0,0,0]}]}]);assert.equal(malformed.pages[0].blocks[0].lineRects,undefined);
});
test("page count, order, missing structured output and unsafe result address rejected",()=>{
 assert.throws(()=>paddleJSONL(jsonl,2),/页数/);assert.throws(()=>paddleJSONL(JSON.stringify({result:{layoutParsingResults:[{markdown:{text:"plain"}}]}}),1),/版面/);
 assert.throws(()=>paddleJSONL(JSON.stringify({result:{layoutParsingResults:[{prunedResult:{...row,page_index:1}}]}}),1),/页码/);
 for(const url of ["http://test.bcebos.com/x","https://bcebos.com.evil.invalid/x","https://user:pass@test.bcebos.com/x","https://127.0.0.1/x"])assert.throws(()=>paddleResultURL(url));
});
test("timeout or failure never resubmits; token or raw upstream error not echoed",async()=>{
 let n=0;const req=async(method)=>{if(method==="POST"){n++;return JSON.stringify({code:0,data:{jobId:"job"}});}return JSON.stringify({code:0,data:{jobId:"job",state:"pending"}});};
 await assert.rejects(parsePaddlePDF(req,bytes,"private","PP-StructureV3",base,control),/超时/);assert.equal(n,1);
 await assert.rejects(parsePaddlePDF(async()=>JSON.stringify({code:12001,msg:"private"}),bytes,"private","PP-StructureV3",base,control),e=>e.message.includes("额度")&&!e.message.includes("private"));
});
test("cancel prevents submission and download",async()=>{
 let n=0;await assert.rejects(parsePaddlePDF(async()=>{n++;return ""},bytes,"private","PP-StructureV3",base,{...control,check(){throw Error("cancelled");}}));assert.equal(n,0);
});
