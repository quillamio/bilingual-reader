/** AI Studio asynchronous document parsing. Independent implementation of the
 * documented HTTP protocol; no Node-only SDK, remote images, or shell execution.
 * https://ai.baidu.com/ai-doc/AISTUDIO/fml7mozw5
 */
import type { NativeBlock, NativeBlockType, NativeDocument, NativePage, NativeRect } from "./pdfNativeModel.ts";
export const PADDLE_JOBS = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs";
export const PADDLE_MODELS = ["PaddleOCR-VL-1.6","PP-StructureV3","PaddleOCR-VL-1.5","PaddleOCR-VL"] as const;
export const PADDLE_RESULT_LIMIT = 40 * 1024 * 1024;
export type PaddleRequest = (method:"GET"|"POST",url:string,headers:Record<string,string>,body?:ArrayBuffer)=>Promise<string>;
export interface PaddleControl { check:()=>void; wait:(ms:number)=>Promise<void>; maxPolls?:number }
export class PaddleHTTPError extends Error {
  readonly status:number;
  constructor(status:number) {
    super(status===429?"PaddleOCR 请求限流，请稍后重试。":status===403?"PaddleOCR 请求被拒绝，请检查解析额度及账号权限。":status===401?"PaddleOCR Access Token 无效。":"PaddleOCR 请求失败（HTTP "+status+"）。");
    this.name="PaddleHTTPError";this.status=status;
  }
}
export function paddleResultURL(raw:unknown):string {
  if(typeof raw!=="string"||/\s/u.test(raw))throw new Error("PaddleOCR 结果地址无效。");
  let u:URL;
  try{u=new URL(raw);}catch(_){throw new Error("PaddleOCR 结果地址无效。");}
  if(u.protocol!=="https:"||u.username||u.password||u.hash||(u.port&&u.port!=="443")||
     !(u.hostname==="bcebos.com"||u.hostname.endsWith(".bcebos.com")||u.hostname==="paddleocr.aistudio-app.com")) {
    throw new Error("PaddleOCR 返回未经允许的结果存储地址。");
  }
  return raw;
}
export function paddleMultipart(bytes:Uint8Array,model:string,boundary:string):ArrayBuffer {
  if(!(PADDLE_MODELS as readonly string[]).includes(model)||!/^[A-Za-z0-9]{12,80}$/u.test(boundary))throw new Error("PaddleOCR 模型或 multipart 参数无效。");
  const options:Record<string,boolean>={useDocOrientationClassify:false,useDocUnwarping:false,useChartRecognition:false,formatBlockContent:false,visualize:false};
  if(model==="PP-StructureV3"){options.useTableRecognition=true;options.useFormulaRecognition=true;}
  else {options.useLayoutDetection=true;options.restructurePages=false;options.mergeTables=false;}
  const enc=new TextEncoder();
  const field=(name:string,value:string)=>"--"+boundary+"\r\nContent-Disposition: form-data; name=\""+name+"\"\r\n\r\n"+value+"\r\n";
  const head=enc.encode(field("model",model)+field("optionalPayload",JSON.stringify(options))+"--"+boundary+"\r\nContent-Disposition: form-data; name=\"file\"; filename=\"document.pdf\"\r\nContent-Type: application/pdf\r\n\r\n");
  const tail=enc.encode("\r\n--"+boundary+"--\r\n");
  const out=new Uint8Array(head.length+bytes.length+tail.length);out.set(head);out.set(bytes,head.length);out.set(tail,head.length+bytes.length);return out.buffer;
}
function paddleData(raw:string):any {
  let response:any;
  try{response=JSON.parse(raw);}catch(_){throw new Error("PaddleOCR API 响应格式异常。");}
  if(response?.code!==0||!response.data){
    const code=response?.code;
    if(code===12001)throw new Error("PaddleOCR 今日解析页数额度已用完。");
    if(code===12002)throw new Error("PaddleOCR 请求频率过高。");
    if(code===401)throw new Error("PaddleOCR Access Token 无效。");
    throw new Error("PaddleOCR API 请求未成功；请检查模型、额度和文档。");
  }
  return response.data;
}
export function paddleJSONL(raw:string,expected:number):any[] {
  if(!raw||raw.length>PADDLE_RESULT_LIMIT||!Number.isSafeInteger(expected)||expected<1||expected>1000)throw new Error("PaddleOCR 结果容量或页数无效。");
  const pages:any[]=[];
  for(const line of raw.split(/\r?\n/u)){
    if(!line.trim())continue;
    let obj:any;
    try{obj=JSON.parse(line);}catch(_){throw new Error("PaddleOCR JSONL 解析失败。");}
    const rows=obj?.result?.layoutParsingResults;
    if(!Array.isArray(rows)||!rows.length||rows.length>expected-pages.length)throw new Error("PaddleOCR 返回异常页数。");
    for(const row of rows){
      const p=row?.prunedResult;
      if(!p||!Array.isArray(p.parsing_res_list))throw new Error("PaddleOCR 未返回结构化版面；拒绝仅以 Markdown 重建。");
      if(p.page_index!=null&&p.page_index!==pages.length)throw new Error("PaddleOCR 页码异常或顺序不一致。");
      pages.push(p);
    }
  }
  if(pages.length!==expected)throw new Error("PaddleOCR 结果页数与原始 PDF 不一致；拒绝错误配对。");
  return pages;
}
export async function parsePaddlePDF(request:PaddleRequest,bytes:Uint8Array,token:string,model:string,base:NativeDocument,control:PaddleControl):Promise<NativeDocument> {
  if(!token.trim()||/[\r\n]/u.test(token))throw new Error("请填写 PaddleOCR Access Token。");
  if(bytes.length<5||bytes.length>30*1024*1024||new TextDecoder().decode(bytes.slice(0,5))!=="%PDF-"||base.pages.length<1||base.pages.length>1000)throw new Error("PaddleOCR 插件限制为 30 MB、1000 页 PDF。");
  const boundary="BRPaddle"+Date.now().toString(36)+Math.random().toString(36).slice(2);
  const body=paddleMultipart(bytes,model,boundary);
  const auth={Authorization:"Bearer "+token,Accept:"application/json"};
  control.check();
  const created=paddleData(await request("POST",PADDLE_JOBS,{...auth,"Content-Type":"multipart/form-data; boundary="+boundary},body));
  const id=created.jobId;
  if(typeof id!=="string"||!/^[A-Za-z0-9_-]{1,200}$/u.test(id))throw new Error("PaddleOCR 任务 ID 无效。");
  for(let i=0;i<(control.maxPolls??240);i++){
    control.check();
    const state=paddleData(await request("GET",PADDLE_JOBS+"/"+encodeURIComponent(id),auth));
    control.check();
    if(state.jobId!==id)throw new Error("PaddleOCR 任务不匹配。");
    if(state.state==="done"){
      const url=paddleResultURL(state.resultUrl?.jsonUrl);
      // BOS result URL is itself an access credential. Never send API token or follow redirects.
      const raw=await request("GET",url,{});
      control.check();
      return normalizePaddlePages(base,paddleJSONL(raw,base.pages.length));
    }
    if(state.state==="failed")throw new Error("PaddleOCR 解析任务失败，请查看官方任务历史。");
    if(!["pending","running"].includes(state.state))throw new Error("PaddleOCR 未知任务状态。");
    await control.wait(5000);
  }
  throw new Error("PaddleOCR 等待超时；云端可能仍在处理，请勿直接重复提交。");
}
const types:Record<string,NativeBlockType>={text:"paragraph",paragraph:"paragraph",abstract:"paragraph",doc_title:"heading",paragraph_title:"heading",title:"heading",sub_title:"heading",figure_title:"caption",table_title:"caption",chart_title:"caption",caption:"caption",footnote:"footnote",table:"table",formula:"formula",display_formula:"formula",inline_formula:"formula"};
const translateType=(kind:NativeBlockType)=>["heading","paragraph","caption","footnote"].includes(kind);
const validRect=(r:NativeRect)=>[r.left,r.right,r.top,r.bottom].every(Number.isFinite)&&r.right>r.left&&r.top>r.bottom;
const overlap=(a:NativeRect,b:NativeRect)=>Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.top,b.top)-Math.max(a.bottom,b.bottom));
const area=(r:NativeRect)=>(r.right-r.left)*(r.top-r.bottom);
const matchText=(s:string)=>s.normalize("NFC").replace(/\s+/gu,"").replace(/\u00ad/gu,"");
export function paddleRect(page:NativePage,raw:unknown,width:number,height:number):NativeRect|undefined {
  if(!Array.isArray(raw)||raw.length!==4||raw.some(n=>typeof n!=="number"||!Number.isFinite(n)))return;
  const [x0,y0,x1,y1]=raw;
  if(x0<0||y0<0||x1>width||y1>height||x1<=x0||y1<=y0)return;
  const l=page.layout||{width:page.width,height:page.height,transform:[1,0,0,-1,0,page.height]};
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||Math.abs((width/height)/(l.width/l.height)-1)>.025)return;
  const [a,b,c,d,e,f]=l.transform,det=a*d-b*c;
  if(!Number.isFinite(det)||Math.abs(det)<1e-12)return;
  const p=(x:number,y:number)=>{const u=x*l.width/width-e,v=y*l.height/height-f;return [(d*u-c*v)/det,(a*v-b*u)/det];};
  const points=[p(x0,y0),p(x0,y1),p(x1,y0),p(x1,y1)];
  const rect={left:Math.min(...points.map(q=>q[0])),right:Math.max(...points.map(q=>q[0])),bottom:Math.min(...points.map(q=>q[1])),top:Math.max(...points.map(q=>q[1]))};
  return validRect(rect)?rect:undefined;
}
/** Cloud region rectangles are never used directly as erasure bands.
 * Only local text lines which are geometrically contained, match the entire
 * recognized region, and do not intersect protected artwork can be erased.
 * Unmatched text is translated on continuation sheets instead.
 */
export function normalizePaddlePages(base:NativeDocument,rows:any[]):NativeDocument {
  if(rows.length!==base.pages.length)throw new Error("PaddleOCR 页数不一致。");
  const warnings=[...base.warnings];
  let textCount=0;
  const pages=base.pages.map((page,index)=>{
    const row=rows[index];
    if(page.index!==index||!Array.isArray(row?.parsing_res_list)||row.parsing_res_list.length>10000)throw new Error("PaddleOCR 页面结构无效。");
    const regions=row.parsing_res_list.map((b:any,order:number)=>{
      const kind=typeof b?.block_label==="string"&&Object.prototype.hasOwnProperty.call(types,b.block_label)?types[b.block_label]:"picture";
      const text=typeof b?.block_content==="string"&&b.block_content.length<=200000?b.block_content.trim():"";
      const bbox=paddleRect(page,b?.block_bbox,row.width,row.height);
      return {kind,text,bbox,order};
    });
    // Malformed protected bounds imply that no masking can safely occur on this page.
    const unsafe=regions.some((r:{kind:NativeBlockType;bbox?:NativeRect})=>!r.bbox);
    const protectedRects:NativeRect[]=regions.filter((r:{kind:NativeBlockType;bbox?:NativeRect})=>!translateType(r.kind)&&r.bbox).map((r:{bbox:NativeRect})=>r.bbox);
    const physical=page.blocks.flatMap(b=>b.lineTexts?.length===b.lineRects?.length&&b.lineRects?b.lineRects.map((rect,i)=>({rect,text:b.lineTexts![i]})).filter(l=>validRect(l.rect)):[]);
    const used=new Set<number>();
    let unplaced=0;
    const blocks:NativeBlock[]=regions.flatMap((r:{kind:NativeBlockType;text:string;bbox?:NativeRect;order:number})=>{
      if(!r.text&&!r.bbox)return [];
      const translatable=translateType(r.kind)&&Boolean(r.text);
      const rect=r.bbox;
      const candidates=!unsafe&&translatable&&rect?physical.map((l,i)=>({...l,i})).filter(l=>overlap(rect,l.rect)/area(l.rect)>=.8):[];
      const safe=candidates.length>0&&candidates.every(l=>!used.has(l.i)&&!protectedRects.some(p=>overlap(p,l.rect)>.5))&&matchText(candidates.map(l=>l.text).join(" "))===matchText(r.text);
      if(safe)candidates.forEach(l=>used.add(l.i));
      if(translatable){textCount++;if(!safe)unplaced++;}
      // Tables and formula/figure regions remain artwork; table HTML is never sent for translation.
      return [{id:"paddleocr:"+index+":"+r.order,pageIndex:index,order:r.order,type:r.kind==="table"?"picture":r.kind,text:r.text,source:"paddleocr",bbox:rect||{left:0,bottom:0,right:page.width,top:page.height},lineRects:safe?candidates.map(l=>l.rect):undefined}];
    });
    if(unplaced)warnings.push("PaddleOCR 第 "+(index+1)+" 页 "+unplaced+" 个文本区域未通过原位坐标核验，使用译文续页。");
    if(!blocks.length&&page.blocks.some(b=>b.text.trim()))throw new Error("PaddleOCR 返回空白结果但原始页含文字，拒绝覆盖。");
    // Do not reintroduce PDF.js figure labels as body text; unrecognized regions
    // stay intact in the original page and are flagged for review.
    const missed=physical.filter(l=>!regions.some((r:{bbox?:NativeRect})=>r.bbox&&overlap(r.bbox,l.rect)/area(l.rect)>=.8)).length;
    if(missed)warnings.push("PaddleOCR 第 "+(index+1)+" 页 "+missed+" 行未归入云端区域，保留原文，请核对覆盖率。");
    return {...page,blocks};
  });
  if(!textCount)throw new Error("PaddleOCR 未返回可翻译正文。");
  return {source:"paddleocr",pages,warnings};
}
