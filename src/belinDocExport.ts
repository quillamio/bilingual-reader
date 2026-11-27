import { PDFDocument } from "pdf-lib";
import { BELIN_MAX_BYTES, BELIN_BASE, BelinStorageHTTPError, translateBelinPDF, type BelinRequest } from "./belinDocClient";
import { getBelinKey, getBelinModel, getBelinOCR, getBelinLayout, getBelinContentDisposition } from "./settings";
import { readOriginalAttachment, writePDFFile } from "./pdfVectorExport";
import { importExportedPDF } from "./readerUI";
import { withPDFOperationDeadline, waitForPDFExport } from "./pdfOperationDeadline";
import { PDFExportCancelledError, type PDFExportTask } from "./pdfExportTask";
import { recordDiagnostic } from "./taskDiagnostics";

let active = false;
export async function exportBelinDoc(reader: any, button: HTMLButtonElement | null, task?: PDFExportTask): Promise<void> {
  if (active) throw new Error("已有 BelinDoc 导出任务，请勿重复提交。");
  const key = getBelinKey(), model = getBelinModel(), ocr = getBelinOCR(), layout = getBelinLayout();
  if (!key || !model) throw new Error("请在插件设置中填写 BelinDoc API Key 和官方模型版本。");
  const attachment = Zotero.Items.get(Number(reader?.itemID || 0));
  if (!attachment) throw new Error("未找到 PDF 附件。");
  const win = reader?._iframeWindow || Zotero.getMainWindow();
  if (typeof win?.confirm !== "function" || !win.confirm("BelinDoc 将接收完整原始 PDF（包括参考文献、末页及可能存在的敏感内容），并使用你的账户额度。服务端排版不使用本地段落缓存、科学符号校验或跳页设置。免费额度及水印遵循服务规则。是否同意上传？")) return;
  active = true;
  let temp: any;
  try {
    const original = await readOriginalAttachment(attachment, task);
    if (original.length > BELIN_MAX_BYTES) throw new Error("BelinDoc 插件上传上限为 30 MB。");
    const source = await PDFDocument.load(original,{updateMetadata:false});
    const request: BelinRequest = async (method,url,headers,body,responseType) => {
      task?.throwIfCancelled();
      if (headers["X-Api-Key"] && !url.startsWith(BELIN_BASE)) throw new Error("拒绝向存储地址发送 API Key。");
      try {
        if (!headers["X-Api-Key"]) {
          const main=Zotero.getMainWindow(),abort=new main.AbortController();
          try {
            return await withPDFOperationDeadline("BelinDoc 存储请求",180000,async()=>{
              const response=await main.fetch(url,{method,body:body as ArrayBuffer|undefined,headers,credentials:"omit",redirect:"error",cache:"no-store",signal:abort.signal});
              if(!response.ok) {
                // S3 can return a canonical request and credential information in XML.
                // Extract only an allowlisted code; never display or log the body or URL.
                let xml = "";
                try { xml = await response.text(); } catch (_) { /* preserve HTTP status */ }
                throw new BelinStorageHTTPError(response.status,method === "PUT" ? "upload" : "download",xml);
              }
              return responseType==="arraybuffer"?await response.arrayBuffer():await response.text();
            },()=>abort.abort(),task);
          } finally {abort.abort();}
        }
        const xhr = await withPDFOperationDeadline<any>("BelinDoc 请求",180000,
          () => Zotero.HTTP.request(method,url,{body,headers,responseType,timeout:175000,followRedirects:false,noCache:true,debug:false} as any),undefined,task);
        if (xhr.status < 200 || xhr.status >= 300) throw new Error("HTTP " + xhr.status);
        return responseType === "json" && typeof xhr.response === "string" ? JSON.parse(xhr.response):xhr.response;
      } catch (error: any) {
        if (task?.cancelled || error instanceof PDFExportCancelledError) throw new PDFExportCancelledError();
        if (error instanceof BelinStorageHTTPError) {
          recordDiagnostic("belindoc","request","failure",error.status);
          throw error;
        }
        const status = Number(error?.status || error?.xmlhttp?.status || 0);
        recordDiagnostic("belindoc","request","failure",status);
        throw new Error("BelinDoc 请求失败" + (status >= 400 && status < 600 ? "（HTTP " + status + "）":"（网络、超时或响应异常）") + "；若已提交，请查看云端历史，勿直接重复扣费。");
      }
    };
    const bytes = await withPDFOperationDeadline("BelinDoc 云端流程",30*60*1000,() => translateBelinPDF(request,original,{
      key,model,layout,ocr,contentDisposition:getBelinContentDisposition(),
      check:()=>task?.throwIfCancelled(),
      wait:ms=>waitForPDFExport(ms,task),
      progress:stage=>{ if(button && !task?.cancelled){button.title="BelinDoc："+stage+" · 点击停止";button.setAttribute("aria-label",button.title);} },
      confirmSubmit:info=>Boolean(win.confirm("即将提交云端翻译，原始 "+source.getPageCount()+" 页；模型 "+info.model+"，额度系数 "+info.coefficient+"，OCR "+(info.ocr?"开启":"关闭")+"。剩余免费页："+(info.freePages??"未知")+"；账户页额度："+(info.quota??"未知")+"。实际消耗以服务为准，可能使用付费额度。是否确认提交？")),
    }),()=>task?.cancel(),task);
    if (!bytes) return;
    task?.throwIfCancelled();
    const pdf = await PDFDocument.load(bytes,{updateMetadata:false});
    if (!pdf.getPageCount()) throw new Error("BelinDoc 返回空 PDF。");
    temp=Zotero.getTempDirectory();
    temp.append("belindoc-"+Date.now()+"-"+Math.random().toString(36).slice(2)+".pdf");
    await writePDFFile(temp,bytes,task);
    await importExportedPDF(temp,attachment,layout==="side-by-side"?"BelinDoc 左右对照":layout==="stacked"?"BelinDoc 上下对照":"BelinDoc 译文",task);
    win.alert?.("BelinDoc PDF 已保存为独立附件。云端输出请检查译文及图表完整性。");
  } finally {
    active=false;
    try { if(temp?.exists())temp.remove(false); } catch (_) { /* temporary only */ }
  }
}
