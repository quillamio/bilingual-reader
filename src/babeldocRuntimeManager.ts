/** B2: fail-closed managed runtime installer. Runtime execution belongs to B3. */
export type RuntimeTarget = "macos-arm64"|"macos-x64"|"windows-x64"|"linux-x64";
export interface RuntimeAsset { sha256:string; size:number }
export interface RuntimeRelease {
  version:string; target:RuntimeTarget; runtime:RuntimeAsset;
  assets:RuntimeAsset; unpackedSize:number; fileCount:number; manifestSha256:string;
}
// Candidate CI manifests are not approvals. Populate only after real platform,
// dependency security, source/license and model redistribution reviews.
// This registry is bundled into the trusted XPI, never fetched from an arbitrary URL.
export const APPROVED_RUNTIME_RELEASES: readonly RuntimeRelease[] = [];
export const MAX_RUNTIME_BYTES=1536*1024**2;
export const MAX_UNPACKED_BYTES=4*1024**3;
export const MAX_RUNTIME_FILES=100000;
const digest=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}$/u.test(v);
const positive=(v:unknown,max:number):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>0&&v<=max;
export function runtimeTarget(os:string,abi:string):RuntimeTarget|undefined {
  const cpu=abi.toLowerCase().split("-")[0];
  const arch=["aarch64","arm64"].includes(cpu)?"arm64":["x86_64","x64","amd64"].includes(cpu)?"x64":undefined;
  if(os==="Darwin"&&arch)return "macos-"+arch as RuntimeTarget;
  if(os==="WINNT"&&arch==="x64")return "windows-x64";
  if(os==="Linux"&&arch==="x64")return "linux-x64";
  return undefined;
}
export function runtimeID(release:RuntimeRelease):string {
  if(!/^\d{1,3}\.\d{1,3}\.\d{1,3}-r[1-9]\d{0,3}$/u.test(release.version)||!["macos-arm64","macos-x64","windows-x64","linux-x64"].includes(release.target))throw new Error("运行包版本或平台无效。");
  if(![release.runtime,release.assets].every(a=>a&&digest(a.sha256)&&positive(a.size,MAX_RUNTIME_BYTES))||
     !digest(release.manifestSha256)||!positive(release.unpackedSize,MAX_UNPACKED_BYTES)||!positive(release.fileCount,MAX_RUNTIME_FILES))throw new Error("运行包清单无效。");
  return release.version+"-"+release.target;
}
export function approvedRuntime(target:RuntimeTarget|undefined,registry:readonly RuntimeRelease[]=APPROVED_RUNTIME_RELEASES):RuntimeRelease|undefined {
  if(!target)return undefined;
  const release=registry.find(r=>r.target===target);
  if(release)runtimeID(release);
  return release;
}
export function runtimeURL(release:RuntimeRelease,kind:"runtime"|"assets"):string {
  const id=runtimeID(release);
  return "https://github.com/quillamio/bilingual-reader/releases/download/babeldoc-runtime-"+release.version+"/"+(kind==="runtime"?"babeldoc-"+id+"-runtime.zip":"babeldoc-"+release.version+"-assets.zip");
}
export function allowedRuntimeDownloadFinal(raw:string):boolean {
  try {const u=new URL(raw);return u.protocol==="https:"&&!u.username&&!u.password&&!u.port&&
    (u.hostname==="github.com"&&u.pathname.startsWith("/quillamio/bilingual-reader/releases/download/")||u.hostname==="release-assets.githubusercontent.com"||u.hostname==="objects.githubusercontent.com");}
  catch(_){return false;}
}
export interface RuntimeMember {path:string;size:number;sha256:string;executable:boolean}
export function runtimePathKey(path:unknown):string {
  if(typeof path!=="string"||path.length>500)throw new Error("运行包文件路径无效。");
  const parts=path.split("/");
  if(!(path==="launcher.py"||path==="requirements.lock"||(["python","site"].includes(parts[0])&&parts.length>1))||
    parts.some(p=>!p||p==="."||p===".."||/[. ]$/u.test(p)||/[\\:<>"|?*]/u.test(p)||Array.from(p).some(c=>c.charCodeAt(0)<32)||/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu.test(p)))throw new Error("运行包包含不安全路径。");
  return path.normalize("NFC").toLowerCase();
}
export function validateRuntimeMembers(manifest:unknown,entries:readonly {path:string;size:number}[],release:RuntimeRelease):RuntimeMember[] {
  runtimeID(release);
  const data=manifest as any;
  if(data?.schema!==1||data.target!==release.target||data.version!==release.version.split("-r")[0]||!Array.isArray(data.files)||data.files.length!==release.fileCount||data.files.length>MAX_RUNTIME_FILES)throw new Error("运行包文件清单不匹配。");
  const map=new Map<string,{path:string;size:number}>();
  for(const entry of entries){
    const key=entry.path==="runtime-files.json"?entry.path:runtimePathKey(entry.path);
    if(map.has(key)||!Number.isSafeInteger(entry.size)||entry.size<0||entry.size>512*1024**2)throw new Error("运行包文件重复或容量异常。");
    map.set(key,entry);
  }
  if(map.size!==data.files.length+1||!map.has("runtime-files.json"))throw new Error("运行包存在额外文件。");
  const seen=new Set<string>();let total=0;
  const members:RuntimeMember[]=data.files.map((r:any)=>{
    const key=runtimePathKey(r?.path);
    if(seen.has(key)||!Number.isSafeInteger(r.size)||r.size<0||r.size>512*1024**2||map.get(key)?.size!==r.size||map.get(key)?.path!==r.path||!digest(r.sha256)||typeof r.executable!=="boolean")throw new Error("运行包文件校验清单无效。");
    seen.add(key);total+=r.size;
    return {path:r.path,size:r.size,sha256:r.sha256,executable:r.executable};
  });
  if(total!==release.unpackedSize||total>MAX_UNPACKED_BYTES)throw new Error("运行包解压容量不匹配。");
  // Also refuse file/directory conflicts (A and A/b), regardless of archive order.
  for(const key of seen){const parts=key.split("/");for(let i=1;i<parts.length;i++)if(seen.has(parts.slice(0,i).join("/")))throw new Error("运行包路径冲突。");}
  const executable=release.target==="windows-x64"?"python/python.exe":"python/bin/python3.12";
  if(!members.some(m=>m.path===executable&&m.executable)||!seen.has("launcher.py")||!seen.has("requirements.lock"))throw new Error("缺少运行包入口。");
  return members;
}
export interface RuntimeControl { check():void; progress(message:string):void; onCancel?(handler:()=>void):()=>void }
export interface RuntimeStorage {
  current():Promise<string|undefined>;
  exists(id:string):Promise<boolean>;
  stage():Promise<string>;
  download(stage:string,kind:"runtime"|"assets",url:string,asset:RuntimeAsset,control:RuntimeControl):Promise<void>;
  verifyAndExtract(stage:string,release:RuntimeRelease,control:RuntimeControl):Promise<void>;
  commit(stage:string,id:string,release:RuntimeRelease):Promise<void>;
  select(id:string|undefined):Promise<void>;
  discard(stage:string):Promise<void>;
  remove(id:string):Promise<void>;
  list?():Promise<string[]>;
  verifyInstalled?(id:string,release:RuntimeRelease,control:RuntimeControl):Promise<void>;
}
export class RuntimeManager {
  private busy=false;
  private readonly storage:RuntimeStorage;
  private readonly releases:readonly RuntimeRelease[];
  constructor(storage:RuntimeStorage,releases:readonly RuntimeRelease[]=APPROVED_RUNTIME_RELEASES){this.storage=storage;this.releases=releases;}
  private async exclusive<T>(fn:()=>Promise<T>):Promise<T>{
    if(this.busy)throw new Error("另一个运行包管理操作正在进行。");
    this.busy=true;try{return await fn();}finally{this.busy=false;}
  }
  async install(target:RuntimeTarget,control:RuntimeControl):Promise<string>{
    return this.exclusive(async()=>{
      const release=approvedRuntime(target,this.releases);
      if(!release)throw new Error("当前平台没有正式批准的运行包。");
      const id=runtimeID(release);
      // Do not reselect or execute an existing, potentially modified tree.
      if(await this.storage.exists(id))throw new Error("该版本已安装。请先卸载再重新校验安装。");
      control.check();const stage=await this.storage.stage();
      let committed=false;
      try{
        for(const kind of ["runtime","assets"] as const){
          control.check();control.progress(kind==="runtime"?"下载运行包":"下载离线资产");
          await this.storage.download(stage,kind,runtimeURL(release,kind),release[kind],control);
        }
        control.check();control.progress("校验并解包");
        await this.storage.verifyAndExtract(stage,release,control);
        control.check();await this.storage.commit(stage,id,release);committed=true;
        // Do not cancel after the atomic commit; select only the fully verified tree.
        await this.storage.select(id);return id;
      }finally{
        if(!committed)await this.storage.discard(stage);
      }
    });
  }
  async activate(id:string,control:RuntimeControl):Promise<void>{
    await this.exclusive(async()=>{
      const release=this.releases.find(r=>runtimeID(r)===id);
      if(!release||!this.storage.verifyInstalled)throw new Error("此版本未获批准，不能启用。");
      control.check();await this.storage.verifyInstalled(id,release,control);control.check();await this.storage.select(id);
    });
  }
  async uninstallCurrent():Promise<void>{
    return this.uninstall();
  }
  async uninstall(selected?:string):Promise<void>{
    await this.exclusive(async()=>{
      const current=await this.storage.current();const id=selected??current;if(!id)return;
      if(!/^\d{1,3}\.\d{1,3}\.\d{1,3}-r[1-9]\d{0,3}-(?:macos-arm64|macos-x64|windows-x64|linux-x64)$/u.test(id))throw new Error("已安装版本标识无效。");
      // Clear selection only after removal succeeds; leave other versions intact.
      await this.storage.remove(id);if(current===id)await this.storage.select(undefined);
    });
  }
}
