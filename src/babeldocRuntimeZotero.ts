/** Gecko-backed B2 installation. Never execute a downloaded program here. */
import { APPROVED_RUNTIME_RELEASES, RuntimeManager, runtimeID, runtimeTarget, approvedRuntime,
  validateRuntimeMembers, allowedRuntimeDownloadFinal, type RuntimeControl, type RuntimeRelease,
  type RuntimeStorage, type RuntimeAsset } from "./babeldocRuntimeManager";
import { PDFExportTask } from "./pdfExportTask";

const PREF="extensions.zotero.bilingualreader.runtime.selected";
const INSTALL_ID=/^\d{1,3}\.\d{1,3}\.\d{1,3}-r[1-9]\d{0,3}-(?:macos-arm64|macos-x64|windows-x64|linux-x64)$/u;
const STAGE_ID=/^stage-[a-z0-9-]+$/u;
const g=()=>globalThis as any;
function components(){return g().Components;}
function child(parent:any,name:string):any{
  if(!name||name==="."||name===".."||/[\\/]/u.test(name))throw new Error("运行包路径无效。");
  const file=parent.clone();file.append(name);return file;
}
function dir(file:any):any {
  if(!file.exists())file.create(1,0o700);
  if(!file.isDirectory()||file.isSymlink())throw new Error("拒绝使用非普通目录。");
  return file;
}
function root():any{
  const c=components();
  const profile=c.classes["@mozilla.org/file/directory_service;1"].getService(c.interfaces.nsIProperties).get("ProfD",c.interfaces.nsIFile);
  return dir(child(profile,"bilingual-reader-runtime"));
}
function slot(id:string):any{
  if(!INSTALL_ID.test(id))throw new Error("运行包版本标识无效。");
  return child(root(),id);
}
function stagePath(id:string):any{
  if(!STAGE_ID.test(id))throw new Error("临时安装标识无效。");
  return child(root(),id);
}
function pathFile(parent:any,path:string,makeParents=false):any{
  const names=path.split("/");let current=parent;
  for(let i=0;i<names.length;i++){
    current=child(current,names[i]);
    if(i<names.length-1){
      if(makeParents)dir(current);
      else if(!current.exists()||current.isSymlink()||!current.isDirectory())throw new Error("运行包目录不安全或缺失。");
    }
  }
  return current;
}
function regular(file:any):void{
  if(!file.exists()||file.isSymlink()||!file.isFile())throw new Error("运行包文件缺失或不是普通文件。");
}
function stream(file:any):any{
  regular(file);const c=components();
  const input=c.classes["@mozilla.org/network/file-input-stream;1"].createInstance(c.interfaces.nsIFileInputStream);
  input.init(file,0x01,0o444,0);return input;
}
export function runtimeFileSHA256(file:any):string{
  regular(file);
  // Match Zotero.Utilities.Internal.md5 native stream pattern. Gecko throws
  // NS_ERROR_NOT_AVAILABLE for zero-length streams, which are valid wheel members.
  if(Number(file.fileSize)===0)return "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const c=components(),input=stream(file);
  try{
    const hash=c.classes["@mozilla.org/security/hash;1"].createInstance(c.interfaces.nsICryptoHash);
    hash.init(hash.SHA256);hash.updateFromStream(input,0xffffffff);
    return Array.from(hash.finish(false) as string,ch=>ch.charCodeAt(0).toString(16).padStart(2,"0")).join("");
  }finally{input.close();}
}
function verifyFile(file:any,size:number,sha:string):void{
  regular(file);if(Number(file.fileSize)!==size||runtimeFileSHA256(file)!==sha)throw new Error("运行包 SHA-256 或大小校验失败。");
}
function readJSON(file:any,max=24*1024**2):any{
  regular(file);if(Number(file.fileSize)>max)throw new Error("运行包清单超过容量限制。");
  const c=components(),input=stream(file),binary=c.classes["@mozilla.org/binaryinputstream;1"].createInstance(c.interfaces.nsIBinaryInputStream);
  binary.setInputStream(input);
  try{return JSON.parse(new TextDecoder().decode(new Uint8Array(binary.readByteArray(Number(file.fileSize)))));}
  finally{binary.close();}
}
async function writeJSON(file:any,data:unknown):Promise<void>{
  if(file.exists())throw new Error("拒绝覆盖安装标记。");
  await (Zotero.File as any).putContentsAsync(file.path,JSON.stringify(data));file.permissions=0o600;
}
async function download(file:any,url:string,asset:RuntimeAsset,control:RuntimeControl):Promise<void>{
  if(file.exists())throw new Error("拒绝覆盖安装下载。");
  file.create(0,0o600);
  const win=Zotero.getMainWindow(),abort=new win.AbortController();
  const off=control.onCancel?.(()=>abort.abort());
  const timer=setTimeout(()=>abort.abort(),20*60*1000);
  const io=g().IOUtils;
  if(!io?.write){clearTimeout(timer);off?.();throw new Error("当前 Zotero 不支持安全流式写入。");}
  try{
    control.check();
    const response=await win.fetch(url,{method:"GET",credentials:"omit",cache:"no-store",redirect:"follow",signal:abort.signal});
    if(!response.ok||!allowedRuntimeDownloadFinal(response.url)||!response.body)throw new Error("运行包下载失败或地址异常。");
    const advertised=Number(response.headers.get("Content-Length")||0);
    if(advertised&&advertised!==asset.size)throw new Error("运行包服务器大小不匹配。");
    const reader=response.body.getReader() as unknown as {read():Promise<{done:boolean;value:Uint8Array}>;releaseLock():void};
    let received=0,last=0;
    try{
      while(true){
        control.check();const chunk=await reader.read();if(chunk.done)break;
        received+=chunk.value.byteLength;if(received>asset.size)throw new Error("运行包下载超过批准的大小。");
        await io.write(file.path,new Uint8Array(chunk.value),{mode:"append"});
        if(Date.now()-last>500){control.progress("下载 "+Math.floor(received/asset.size*100)+"%");last=Date.now();}
      }
    }finally{reader.releaseLock();}
    control.check();verifyFile(file,asset.size,asset.sha256);
  }catch(error){
    control.check();
    // Never expose presigned redirect URLs or raw Gecko exceptions.
    if(error instanceof Error&&/^(运行包|拒绝)/u.test(error.message))throw error;
    throw new Error("运行包下载中断或验证失败。");
  }finally{clearTimeout(timer);off?.();abort.abort();}
}
function zipReader(file:any):any{
  const c=components(),zip=c.classes["@mozilla.org/libjar/zip-reader;1"].createInstance(c.interfaces.nsIZipReader);
  zip.open(file);return zip;
}
async function writeZipEntry(zip:any,name:string,file:any,size:number,sha:string):Promise<void>{
  if(file.exists())throw new Error("拒绝覆盖运行包文件。");
  const input=zip.getInputStream(name);
  // Write the entry bytes as a regular file, not extract(): ZIP symlink metadata is ignored.
  try{await (Zotero.File as any).putContentsAsync(file.path,input);}
  finally{try{input.close();}catch(_){/* already closed */}}
  verifyFile(file,size,sha);
}
function listFiles(base:any,prefix="",out:string[]=[]):string[]{
  if(!base.isDirectory()||base.isSymlink())throw new Error("运行包目录不安全。");
  const entries=base.directoryEntries;
  while(entries.hasMoreElements()){
    const file=entries.getNext().QueryInterface(components().interfaces.nsIFile);
    const name=prefix+file.leafName;
    if(file.isSymlink())throw new Error("运行包包含符号链接，拒绝操作。");
    if(file.isDirectory())listFiles(file,name+"/",out);
    else if(file.isFile())out.push(name);
    else throw new Error("运行包包含非普通文件。");
    if(out.length>100005)throw new Error("运行包文件过多。");
  }
  return out;
}
export async function unpackRuntimeArchive(stage:any,release:RuntimeRelease,control:RuntimeControl):Promise<void>{
  const archive=child(stage,"runtime.zip"),assets=child(stage,"assets.zip");
  verifyFile(archive,release.runtime.size,release.runtime.sha256);
  verifyFile(assets,release.assets.size,release.assets.sha256);
  const payload=dir(child(stage,"payload")),zip=zipReader(archive);
  try{
    const entries:{path:string;size:number}[]=[];
    const iterator=zip.findEntries(null);
    while(iterator.hasMore()){
      const name=iterator.getNext(),entry=zip.getEntry(name);
      if(entry.isDirectory||entries.length>=100001)throw new Error("运行包含异常目录或文件过多。");
      entries.push({path:name,size:Number(entry.realSize)});
    }
    const manifestEntry=entries.find(e=>e.path==="runtime-files.json");
    if(!manifestEntry||manifestEntry.size>24*1024**2)throw new Error("运行包清单无效。");
    const file=child(payload,"runtime-files.json");
    await writeZipEntry(zip,"runtime-files.json",file,manifestEntry.size,release.manifestSha256);
    const members=validateRuntimeMembers(readJSON(file),entries,release);
    let i=0;
    for(const member of members){
      control.check();const destination=pathFile(payload,member.path,true);
      await writeZipEntry(zip,member.path,destination,member.size,member.sha256);
      destination.permissions=member.executable?0o700:0o600;
      if(++i%25===0){control.progress("校验文件 "+i+"/"+members.length);await Zotero.Promise.delay(0);}
    }
  }finally{zip.close();}
  control.check();assets.moveTo(payload,"offline-assets.zip");
  await writeJSON(child(payload,"installed.json"),{schema:1,id:runtimeID(release)});
}
async function verifyInstalled(id:string,release:RuntimeRelease,control:RuntimeControl):Promise<void>{
  const folder=slot(id);if(!folder.exists()||folder.isSymlink()||!folder.isDirectory())throw new Error("已安装运行包缺失。");
  const manifestFile=child(folder,"runtime-files.json");regular(manifestFile);
  if(runtimeFileSHA256(manifestFile)!==release.manifestSha256)throw new Error("已安装运行包清单已修改。");
  const manifest=readJSON(manifestFile);
  const paths=listFiles(folder).sort();
  const expected=[...(Array.isArray(manifest?.files)?manifest.files.map((m:any)=>m.path):[]),"runtime-files.json","offline-assets.zip","installed.json"].sort();
  if(JSON.stringify(paths)!==JSON.stringify(expected))throw new Error("已安装运行包文件列表已修改。");
  const entries=manifest.files.map((m:any)=>({path:m.path,size:m.size}));entries.push({path:"runtime-files.json",size:Number(manifestFile.fileSize)});
  const members=validateRuntimeMembers(manifest,entries,release);
  let i=0;
  for(const member of members){control.check();verifyFile(pathFile(folder,member.path),member.size,member.sha256);
    if(++i%25===0){control.progress("复核文件 "+i+"/"+members.length);await Zotero.Promise.delay(0);}}
  verifyFile(child(folder,"offline-assets.zip"),release.assets.size,release.assets.sha256);
  if(readJSON(child(folder,"installed.json"),4096)?.id!==id)throw new Error("运行包安装标记不匹配。");
}
function installedIDs():string[]{
  const result:string[]=[],entries=root().directoryEntries;
  while(entries.hasMoreElements()){
    const file=entries.getNext().QueryInterface(components().interfaces.nsIFile);
    if(INSTALL_ID.test(file.leafName)&&file.isDirectory()&&!file.isSymlink()){
      try{if(readJSON(child(file,"installed.json"),4096)?.id===file.leafName)result.push(file.leafName);}catch(_){/* unowned directory */}
    }
  }
  return result.sort();
}
const storage:RuntimeStorage={
  current:async()=>{const value=(Zotero.Prefs as any).get(PREF,true);return typeof value==="string"&&value?value:undefined;},
  exists:async id=>slot(id).exists(),
  stage:async()=>{
    const file=child(root(),"stage-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2));
    file.createUnique(1,0o700);return file.leafName;
  },
  download:async(stage,kind,url,asset,control)=>download(child(dir(stagePath(stage)),kind+".zip"),url,asset,control),
  verifyAndExtract:async(stage,release,control)=>unpackRuntimeArchive(dir(stagePath(stage)),release,control),
  commit:async(stage,id,release)=>{
    if(id!==runtimeID(release)||slot(id).exists())throw new Error("运行包目标目录已存在。");
    const path=dir(stagePath(stage));dir(child(path,"payload")).moveTo(root(),id);
    // Once the verified tree is atomically renamed, failure to clean its stage
    // must not remove it or change the active version unexpectedly.
    try{path.remove(true);}catch(_){/* private stale stage */}
  },
  select:async id=>{(Zotero.Prefs as any).set(PREF,id||"",true);},
  discard:async stage=>{const path=stagePath(stage);if(path.exists()&&!path.isSymlink()&&path.isDirectory())path.remove(true);},
  remove:async id=>{
    const path=slot(id);
    if(!path.exists()||path.isSymlink()||!path.isDirectory()||readJSON(child(path,"installed.json"),4096)?.id!==id)throw new Error("拒绝删除非插件管理目录。");
    listFiles(path);path.remove(true);
  },
  list:async()=>installedIDs(),
  verifyInstalled,
};
const manager=new RuntimeManager(storage);
let active:PDFExportTask|undefined;
export function stopRuntimeInstallation():void{active?.cancel();}
function platform(){
  const c=components();
  const app=c.classes["@mozilla.org/xre/app-info;1"].getService(c.interfaces.nsIXULRuntime);
  return runtimeTarget(String(app.OS),String(app.XPCOMABI));
}
export function bindManagedRuntimePreferences(doc:Document):void{
  const get=<T extends HTMLElement>(id:string)=>doc.getElementById("bilingualreader-runtime-"+id) as T|null;
  const status=get<HTMLElement>("status"),install=get<HTMLButtonElement>("install"),cancel=get<HTMLButtonElement>("cancel");
  const versions=get<HTMLSelectElement>("versions"),activate=get<HTMLButtonElement>("activate"),remove=get<HTMLButtonElement>("remove");
  if(!status||!install||!cancel||!versions||!activate||!remove)return;
  const win=doc.defaultView;
  const set=(message:string)=>{status.textContent=message;};
  const refresh=async(message?:string)=>{
    try{
      const target=platform(),release=approvedRuntime(target),current=await storage.current(),installed=installedIDs();
      const previous=versions.value;versions.replaceChildren();
      for(const id of installed){const option=doc.createElementNS("http://www.w3.org/1999/xhtml","option") as HTMLOptionElement;option.value=id;option.textContent=id+(id===current?"（当前）":"");versions.append(option);}
      if(installed.includes(previous))versions.value=previous;else if(current&&installed.includes(current))versions.value=current;
      install.disabled=Boolean(active)||!release||installed.includes(runtimeID(release));
      cancel.disabled=!active;
      remove.disabled=Boolean(active)||!versions.value;
      activate.disabled=Boolean(active)||!versions.value||!APPROVED_RUNTIME_RELEASES.some(r=>r.target===target&&runtimeID(r)===versions.value);
      set(message||(target?("平台："+target+"；"+(release?"批准版本 "+release.version:"正式运行包尚未批准，自动安装关闭")):"当前平台不受支持。"));
    }catch(_){install.disabled=activate.disabled=remove.disabled=true;cancel.disabled=!active;set("无法读取运行包状态。");}
  };
  const operation=async(fn:(control:RuntimeControl)=>Promise<unknown>)=>{
    if(active)return;
    const task=new PDFExportTask();active=task;await refresh("正在处理运行包…");
    let result="运行包操作完成。";
    try{await fn({check:()=>task.throwIfCancelled(),onCancel:cb=>task.onCancel(cb),progress:set});}
    catch(error){result=task.cancelled?"操作已取消，原有版本保留。":error instanceof Error&&/^[\p{Script=Han}]/u.test(error.message)?error.message:"运行包操作失败；未启用未经校验的版本。";}
    finally{active=undefined;await refresh(result);}
  };
  versions.addEventListener("change",()=>{void refresh();});
  install.addEventListener("click",()=>{
    const target=platform(),release=approvedRuntime(target);
    if(!target||!release)return;
    const size=Math.ceil((release.runtime.size+release.assets.size)/1024**2);
    if(!win?.confirm("下载安装 BabelDOC "+release.version+"（约 "+size+" MiB）。仅写入 Zotero 配置目录，安装不翻译论文、不消耗 API 额度；后续翻译可能调用所选第三方服务。继续？"))return;
    void operation(control=>manager.install(target,control));
  });
  cancel.addEventListener("click",stopRuntimeInstallation);
  activate.addEventListener("click",()=>{const id=versions.value;if(id)void operation(control=>manager.activate(id,control));});
  remove.addEventListener("click",()=>{const id=versions.value;if(id&&win?.confirm("卸载 "+id+"？仅删除该插件管理的运行包，不删除 PDF 附件、译文或翻译 API 设置。"))void operation(()=>manager.uninstall(id));});
  void refresh();
}
