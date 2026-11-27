/** Official, bounded document parsing protocols with injected transport. */
export type ParseRequest = (method:"GET"|"POST"|"PUT",url:string,headers:Record<string,string>,body?:string|ArrayBuffer)=>Promise<any>;
export interface ParsedPage { index:number; markdown:string }
export interface ParseControl { check:()=>void; wait:(ms:number)=>Promise<void>; maxPolls?:number }
const DOC2X="https://v2.doc2x.noedgeai.com/api/v2/parse/";
const MATHPIX="https://api.mathpix.com/v3/pdf";
export function parseStorageURL(value:unknown):string {
  let u:URL;
  try {u=new URL(String(value));}catch(_){throw new Error("无效签名存储地址。");}
  const domains=["noedgeai.com","amazonaws.com","amazonaws.com.cn","aliyuncs.com","myqcloud.com","volces.com","r2.cloudflarestorage.com"];
  if(u.protocol!=="https:"||u.username||u.password||(u.port&&u.port!=="443")||!domains.some(d=>u.hostname===d||u.hostname.endsWith("."+d)))throw new Error("拒绝未经允许的存储地址。");
  return u.href;
}
function identifier(value:unknown):string {
  if(typeof value!=="string"||!/^[A-Za-z0-9_-]{1,256}$/u.test(value))throw new Error("解析任务 ID 无效。");
  return value;
}
function docData(value:any):any {
  if(value?.code!=="success"||!value.data)throw new Error("Doc2X 请求失败，请检查密钥、额度及服务历史。");
  return value.data;
}
export async function parseDoc2X(request:ParseRequest,bytes:Uint8Array,key:string,model:string,control:ParseControl):Promise<ParsedPage[]> {
  if(!key||!["v2","v3-2026"].includes(model))throw new Error("Doc2X 密钥或模型无效。");
  const h={Authorization:"Bearer "+key,"Content-Type":"application/json"};
  control.check();
  const upload=docData(await request("POST",DOC2X+"preupload",h,JSON.stringify({model})));
  const uid=identifier(upload.uid),url=parseStorageURL(upload.url);
  control.check();
  await request("PUT",url,{},bytes.slice().buffer as ArrayBuffer);
  for(let i=0;i<(control.maxPolls??240);i++){
    control.check();
    const data=docData(await request("GET",DOC2X+"status?uid="+encodeURIComponent(uid),h));
    if(data.status==="failed")throw new Error("Doc2X 解析失败，请查看服务历史。");
    if(data.status==="success"){
      if(!Array.isArray(data.result?.pages))throw new Error("Doc2X 未返回分页结果。");
      return data.result.pages.map((p:any)=>({index:p.page_idx,markdown:typeof p.md==="string"?p.md:""}));
    }
    if(data.status!=="processing")throw new Error("Doc2X 未知任务状态。");
    await control.wait(3000);
  }
  throw new Error("Doc2X 等待超时，云端可能仍在运行，请勿重复提交。");
}
export function mathpixForm(bytes:Uint8Array,boundary:string):ArrayBuffer {
  if(!/^[A-Za-z0-9]{12,80}$/u.test(boundary))throw new Error("Invalid multipart boundary");
  const e=new TextEncoder();
  const head=e.encode("--"+boundary+"\r\nContent-Disposition: form-data; name=\"options_json\"\r\n\r\n"+JSON.stringify({metadata:{improve_mathpix:false}})+"\r\n--"+boundary+"\r\nContent-Disposition: form-data; name=\"file\"; filename=\"document.pdf\"\r\nContent-Type: application/pdf\r\n\r\n");
  const tail=e.encode("\r\n--"+boundary+"--\r\n");
  const out=new Uint8Array(head.length+bytes.length+tail.length);
  out.set(head);out.set(bytes,head.length);out.set(tail,head.length+bytes.length);return out.buffer;
}
export async function parseMathpix(request:ParseRequest,bytes:Uint8Array,appID:string,key:string,control:ParseControl):Promise<ParsedPage[]> {
  if(!appID||!key)throw new Error("Mathpix 需要 App ID 和 App Key。");
  const h={app_id:appID,app_key:key};
  const boundary="BRMathpix"+Date.now().toString(36)+Math.random().toString(36).slice(2);
  control.check();
  const upload=await request("POST",MATHPIX,{...h,"Content-Type":"multipart/form-data; boundary="+boundary},mathpixForm(bytes,boundary));
  const id=identifier(upload?.pdf_id),url=MATHPIX+"/"+encodeURIComponent(id);
  for(let i=0;i<(control.maxPolls??240);i++){
    control.check();
    const status=await request("GET",url,h);
    if(status?.status==="error"||status?.error)throw new Error("Mathpix 解析失败，请查看服务历史。");
    if(status?.status==="completed"){
      control.check();
      const result=await request("GET",url+".lines.json",h);
      if(!Array.isArray(result?.pages))throw new Error("Mathpix 未返回分页结果。");
      return result.pages.map((p:any)=>({index:p.page-1,markdown:Array.isArray(p.lines)?p.lines.filter((l:any)=>l?.conversion_output!==false).map((l:any)=>typeof l?.text_display==="string"&&l.text_display.trim()?l.text_display:typeof l?.text==="string"?l.text:"").filter(Boolean).join("\n\n"):""}));
    }
    if(!["received","loaded","split"].includes(status?.status))throw new Error("Mathpix 未知任务状态。");
    await control.wait(3000);
  }
  throw new Error("Mathpix 等待超时，云端可能仍在运行，请勿重复提交。");
}
