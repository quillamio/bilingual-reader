import { PDFDocument } from "pdf-lib";
import { getLocalPDFURL,getLocalPDFToken,getLocalPDFEngine,getPDFExportLayout } from "./settings";
import { validateDoclingEndpoint } from "./pdfNativeDocling";
import { readOriginalAttachment,writePDFFile,composeSideBySidePDF } from "./pdfVectorExport";
import { importExportedPDF } from "./readerUI";
import { withPDFOperationDeadline } from "./pdfOperationDeadline";
import { checkBelinPDF } from "./belinDocClient";
import { PDFExportCancelledError,type PDFExportTask } from "./pdfExportTask";
import { recordDiagnostic } from "./taskDiagnostics";
let active=false;
export async function exportLocalPDF(reader:any,button:HTMLButtonElement|null,task?:PDFExportTask):Promise<void>{
  if(active)throw new Error("本地文档翻译正在运行。");
  const engine=getLocalPDFEngine(),url=validateDoclingEndpoint(getLocalPDFURL()),token=getLocalPDFToken();
  if(!/^[A-Za-z0-9_-]{24,128}$/u.test(token))throw new Error("请配置本机桥接服务访问令牌（至少24位）。");
  const attachment=Zotero.Items.get(Number(reader?.itemID||0));
  if(!attachment)throw new Error("未找到原始 PDF。");
  const win=reader?._iframeWindow||Zotero.getMainWindow();
  if(typeof win?.confirm!=="function"||!win.confirm("将完整 PDF 发送到本机 "+engine+" 桥接服务。该引擎可能按本机配置将文档文本发送给外部翻译服务并消耗额度，不使用插件段落缓存、跳页或科学符号校验。继续？"))return;
  active=true;let temp:any;
  const side=getPDFExportLayout()==="side-by-side";
  recordDiagnostic(engine,"export","start");
  try{
    const original=await readOriginalAttachment(attachment,task);
    if(original.length>30*1024*1024)throw new Error("本地桥接上限为30 MB。");
    if(button){button.title=engine+" 本机翻译中 · 点击停止";button.setAttribute("aria-label",button.title);}
    const main=Zotero.getMainWindow();
    const abort=new main.AbortController();
    const cancel=task?.onCancel(()=>abort.abort());
    let result:Uint8Array;
    try{
      result=await withPDFOperationDeadline("本地 PDF 翻译",31*60*1000,async()=>{
        const response=await main.fetch(url+"/translate?engine="+engine+"&output="+(side?"mono":"dual"),{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/pdf"},body:original.slice().buffer as ArrayBuffer,credentials:"omit",redirect:"error",signal:abort.signal,cache:"no-store"});
        if(!response.ok)throw new Error("本机翻译服务失败（HTTP "+response.status+"），请检查安装和配置。");
        return new Uint8Array(await response.arrayBuffer());
      },()=>abort.abort(),task);
    }finally{cancel?.();}
    task?.throwIfCancelled();checkBelinPDF(result);
    const translated=await PDFDocument.load(result,{updateMetadata:false});
    if(!translated.getPageCount())throw new Error("本机翻译返回空 PDF。");
    if(side){
      const count=(await PDFDocument.load(original,{updateMetadata:false})).getPageCount();
      if(translated.getPageCount()!==count)throw new Error("本机译文页数与原始 PDF 不一致，不能可靠左右配对。");
      async function* pages(){for(let index=0;index<count;index++){task?.throwIfCancelled();const doc=await PDFDocument.create();const [page]=await doc.copyPages(translated,[index]);doc.addPage(page);yield {pageIndex:index,bytes:await doc.save()};}}
      result=await composeSideBySidePDF(original,pages(),count,task);
    }
    task?.throwIfCancelled();
    temp=Zotero.getTempDirectory();temp.append("local-pdf-"+Date.now()+"-"+Math.random().toString(36).slice(2)+".pdf");
    await writePDFFile(temp,result,task);
    await importExportedPDF(temp,attachment,engine+(side?" 左右对照":" 引擎双语版"),task);
    recordDiagnostic(engine,"export","success");
    win.alert?.("本机翻译 PDF 已保存。请核对完整性。");
  }catch(error){recordDiagnostic(engine,"export",task?.cancelled?"cancelled":"failure");if(task?.cancelled)throw new PDFExportCancelledError();throw error;}
  finally{active=false;try{if(temp?.exists())temp.remove(false);}catch(_){/* temporary only */}}
}
