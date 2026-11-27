import test from "node:test";
import assert from "node:assert/strict";
import {runtimeTarget,runtimeID,runtimeURL,allowedRuntimeDownloadFinal,runtimePathKey,validateRuntimeMembers,RuntimeManager,approvedRuntime} from "../src/babeldocRuntimeManager.ts";
const sha="a".repeat(64);
const files=[{path:"python/bin/python3.12",size:1,sha256:sha,executable:true},{path:"launcher.py",size:1,sha256:sha,executable:false},{path:"requirements.lock",size:1,sha256:sha,executable:false}];
const release={version:"0.7.1-r1",target:"macos-arm64",runtime:{size:123,sha256:sha},assets:{size:456,sha256:sha},unpackedSize:3,fileCount:3,manifestSha256:sha};
const manifest={schema:1,version:"0.7.1",target:"macos-arm64",files};
const entries=[...files,{path:"runtime-files.json",size:100}];
test("only approved, fixed platform release URLs are generated; no candidate is approved",()=>{
 assert.equal(runtimeTarget("Darwin","aarch64-gcc3"),"macos-arm64");assert.equal(runtimeTarget("Darwin","x86_64-gcc3"),"macos-x64");assert.equal(runtimeTarget("WINNT","aarch64-msvc"),undefined);
 assert.equal(approvedRuntime("macos-arm64"),undefined);assert.equal(approvedRuntime("macos-arm64",[release]),release);
 assert.ok(runtimeURL(release,"runtime").startsWith("https://github.com/quillamio/bilingual-reader/releases/download/"));
 assert.throws(()=>runtimeID({...release,version:"../../evil"}));
 assert.equal(allowedRuntimeDownloadFinal("https://release-assets.githubusercontent.com/example"),true);assert.equal(allowedRuntimeDownloadFinal("https://release-assets.githubusercontent.com.evil.test/x"),false);
});
test("archive exact members, target, size and case-insensitive path collisions checked",()=>{
 assert.deepEqual(validateRuntimeMembers(manifest,entries,release),files);
 for(const p of ["../x","python/../x","site/C:/x","site/CON.txt","site/foo\\\\x","site/foo."])assert.throws(()=>runtimePathKey(p));
 assert.throws(()=>validateRuntimeMembers(manifest,[...entries,{path:"site/extra",size:1}],release));
 assert.throws(()=>validateRuntimeMembers(manifest,[...entries,{path:"LAUNCHER.py",size:1}],release));
 assert.throws(()=>validateRuntimeMembers({...manifest,target:"linux-x64"},entries,release));
 assert.throws(()=>validateRuntimeMembers(manifest,entries,{...release,unpackedSize:4}));
});
function fixture(fail){
 let current="0.7.0-r1-macos-arm64",calls=[];
 const s={current:async()=>current,exists:async()=>false,stage:async()=>(calls.push("stage"),"stage"),
 download:async(_,kind)=>{calls.push(kind);if(kind===fail)throw Error("download failed");},
 verifyAndExtract:async()=>{calls.push("verify");if(fail==="verify")throw Error("digest mismatch");},
 commit:async()=>{calls.push("commit");if(fail==="commit")throw Error("commit failed");},
 select:async(id)=>{calls.push("select");current=id;},discard:async()=>{calls.push("discard");},remove:async(id)=>{calls.push("remove:"+id);}};
 return {s,calls,current:()=>current};
}
const control={check(){},progress(){}};
test("install downloads both assets, verifies before selecting and preserves previous version on failure",async()=>{
 for(const fail of ["runtime","assets","verify","commit"]){const x=fixture(fail);await assert.rejects(new RuntimeManager(x.s,[release]).install(release.target,control));assert.equal(x.current(),"0.7.0-r1-macos-arm64");assert.equal(x.calls.at(-1),"discard");assert.ok(!x.calls.includes("select"));}
 const x=fixture();assert.equal(await new RuntimeManager(x.s,[release]).install(release.target,control),runtimeID(release));assert.deepEqual(x.calls,["stage","runtime","assets","verify","commit","select"]);
});
test("no unapproved download; uninstall removes only selected known-shaped version",async()=>{
 const x=fixture();const m=new RuntimeManager(x.s);await assert.rejects(m.install(release.target,control),/批准/);assert.equal(x.calls.length,0);await m.uninstallCurrent();assert.deepEqual(x.calls,["remove:0.7.0-r1-macos-arm64","select"]);assert.equal(x.current(),undefined);
});
test("cancelled install discards stage and cannot activate",async()=>{
 const x=fixture();let checks=0;await assert.rejects(new RuntimeManager(x.s,[release]).install(release.target,{...control,check(){if(++checks>=3)throw Error("cancelled");}}));assert.equal(x.calls.at(-1),"discard");assert.ok(!x.calls.includes("commit"));
});

test("switch version requires re-verification; removing inactive version preserves selection",async()=>{
 const x=fixture();x.s.verifyInstalled=async(id)=>{x.calls.push("rehash:"+id);};
 const m=new RuntimeManager(x.s,[release]);await m.activate(runtimeID(release),control);
 assert.deepEqual(x.calls,["rehash:"+runtimeID(release),"select"]);
 await m.uninstall("0.7.0-r1-macos-arm64");assert.equal(x.current(),runtimeID(release));
 await assert.rejects(m.activate("0.7.2-r1-macos-arm64",control),/批准/);
});
