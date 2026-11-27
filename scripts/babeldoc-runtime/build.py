"""B1 builder: official standalone CPython + wheelhouse + independent model archive.
Candidate output only; no release, installer, system changes or credentials.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import subprocess
import sys
import stat
import unicodedata
import tarfile
import tempfile
import urllib.parse
import urllib.request
import zipfile

HERE=Path(__file__).resolve().parent
PINS=json.loads((HERE/"pins.json").read_text(encoding="utf-8"))
INDEX="https://pypi.org/simple"

def sha256(path):
    with path.open("rb") as f:
        return hashlib.file_digest(f,"sha256").hexdigest()

def host_target():
    osname={"Darwin":"macos","Windows":"windows","Linux":"linux"}.get(platform.system())
    cpu={"aarch64":"arm64","arm64":"arm64","x86_64":"x64","amd64":"x64"}.get(platform.machine().lower())
    return f"{osname}-{cpu}"

def checked_download(url,path,size,digest):
    with urllib.request.urlopen(url,timeout=60) as response, path.open("xb") as out:
        final=urllib.parse.urlsplit(response.geturl())
        if final.scheme!="https" or not (final.hostname=="github.com" or final.hostname.endswith(".githubusercontent.com")):
            raise ValueError("Unexpected interpreter download host")
        total=0
        h=hashlib.sha256()
        for chunk in iter(lambda:response.read(1024*1024),b""):
            total+=len(chunk)
            if total>size: raise ValueError("Interpreter archive too large")
            h.update(chunk);out.write(chunk)
        if total!=size or h.hexdigest()!=digest: raise ValueError("Interpreter digest mismatch")

def safe_extract(path,destination):
    # Archive is pinned before this point. Python tar data filter verifies paths
    # and links inside destination; keep legitimate internal interpreter symlinks.
    names=set();total=0
    with tarfile.open(path,"r:gz") as tar:
        members=tar.getmembers()
        if len(members)>100000: raise ValueError("Too many archive entries")
        for m in members:
            p=PurePosixPath(m.name)
            if not p.parts or p.parts[0]!="python" or p.is_absolute() or ".." in p.parts or "\\" in m.name or ":" in m.name:
                raise ValueError("Unsafe interpreter archive path")
            name=str(p)
            if name in names: raise ValueError("Duplicate archive path")
            names.add(name);total+=m.size
            if total>1024**3 or not (m.isfile() or m.isdir() or m.issym() or m.islnk()):
                raise ValueError("Invalid archive member")
        tar.extractall(destination,filter="data")

def py_path(root):
    for candidate in (root/"python"/"python.exe",root/"python"/"bin"/"python3.12"):
        if candidate.is_file(): return candidate
    raise RuntimeError("Standalone interpreter not found")

def clean_env(home):
    env={k:v for k,v in os.environ.items() if not k.startswith(("PYTHON","PIP_","UV_","OPENAI_","HF_","BABELDOC_"))}
    env.update({"HOME":str(home),"USERPROFILE":str(home),"PIP_CONFIG_FILE":os.devnull,
                "PYTHONNOUSERSITE":"1","HF_HUB_DISABLE_TELEMETRY":"1","DO_NOT_TRACK":"1"})
    return env

def run(cmd,home,timeout=900):
    home.mkdir(parents=True,exist_ok=True)
    subprocess.run([str(x) for x in cmd],check=True,timeout=timeout,env=clean_env(home),cwd=home)

def lock_from_report(report,target):
    rows=json.loads(report.read_text(encoding="utf-8"))["install"]
    names=set();requirements=[];metadata=[]
    for row in rows:
        m=row["metadata"]; name=re.sub(r"[-_.]+","-",m["name"]).lower();version=m["version"]
        if not re.fullmatch(r"[a-z0-9-]+",name) or not re.fullmatch(r"[A-Za-z0-9.!+_-]+",version) or name in names:
            raise ValueError("Invalid dependency identity")
        names.add(name)
        info=row["download_info"];u=urllib.parse.urlsplit(info["url"])
        digest=info["archive_info"]["hashes"]["sha256"]
        if u.scheme!="https" or u.hostname!="files.pythonhosted.org" or not u.path.endswith(".whl") or not re.fullmatch(r"[a-f0-9]{64}",digest):
            raise ValueError("Only hashed official PyPI wheels accepted")
        if name=="babeldoc" and (version!=PINS["babeldoc"]["version"] or digest!=PINS["targets"][target]["wheelSha256"]):
            raise ValueError("BabelDOC wheel differs from published pin")
        requirements.append(f"{name}=={version} --hash=sha256:{digest}")
        metadata.append({"name":name,"version":version,"sha256":digest,"wheel":Path(u.path).name,
                         "license":m.get("license_expression") or m.get("license") or "REVIEW_REQUIRED"})
    if "babeldoc" not in names: raise ValueError("Missing BabelDOC")
    return "\n".join(sorted(requirements))+"\n",sorted(metadata,key=lambda x:x["name"])

def verify_lock(text,target):
    # The first audited build supplies exact platform-specific wheel hashes.
    # Canonical LF avoids a different digest solely due to Windows CRLF.
    data=text.replace("\r\n","\n").encode("utf-8")
    if hashlib.sha256(data).hexdigest()!=PINS["targets"][target]["dependencyLockSha256"]:
        raise ValueError("Dependency lock drift; review and update pinned lock deliberately")
    return data

def pack_candidate(output,archive,wheels,lock):
    # Nested official interpreter archive retained verbatim, not a non-relocatable venv.
    with zipfile.ZipFile(output,"x",compression=zipfile.ZIP_STORED,allowZip64=True) as z:
        z.write(archive,"python.tar.gz");z.write(lock,"requirements.lock")
        z.write(HERE/"launcher.py","launcher.py")
        for wheel in sorted(wheels.glob("*.whl")):z.write(wheel,"wheels/"+wheel.name)

def runtime_member(name,target=None):
    parts=name.split("/")
    if not parts or any(not p or p in (".","..") or p.endswith(("."," ")) or any(ord(c)<32 or c in '\\:<>"|?*' for c in p) or re.fullmatch(r"(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?",p,re.I) for p in parts):
        raise ValueError("Unsafe runtime member: "+name)
    if not (name in ("launcher.py","requirements.lock") or parts[0] in ("python","site") and len(parts)>1):
        raise ValueError("Unexpected runtime member")
    normalized=unicodedata.normalize("NFC",name)
    # Linux terminfo legitimately contains distinct 2621A/2621a entries.
    # Exclusive creation still rejects collisions on case-insensitive mounts.
    return normalized if target=="linux-x64" else normalized.casefold()

def pack_installable(root,output,target):
    # Materialize only regular files. Internal file symlinks are copied as
    # regular aliases; directory symlinks are deliberately refused.
    rows=[];seen=set();total=0
    files=[root/"launcher.py",root/"requirements.lock"]
    for prefix in ("python","site"):
        for directory,dirs,names in os.walk(root/prefix,followlinks=False):
            for d in dirs:
                if (Path(directory)/d).is_symlink():raise ValueError("Runtime directory symlink is unsupported")
            for name in names:
                path=Path(directory)/name
                # PIP entrypoint scripts include a build-machine shebang. The
                # launcher invokes the Python module; it does not need them.
                rel=path.relative_to(root).as_posix()
                if rel.startswith(("site/bin/","site/Scripts/")) or "__pycache__" in path.parts or path.suffix==".pyc":continue
                files.append(path)
    with zipfile.ZipFile(output,"x",compression=zipfile.ZIP_DEFLATED,compresslevel=3,allowZip64=True) as z:
        for path in sorted(files):
            name=path.relative_to(root).as_posix();key=runtime_member(name,target)
            actual=path.resolve(strict=True)
            if not actual.is_relative_to(root.resolve()) or not actual.is_file():raise ValueError("Unsafe runtime file: "+name)
            if key in seen:raise ValueError("Case-folded duplicate runtime file: "+name)
            seen.add(key);size=actual.stat().st_size;total+=size
            if len(seen)>100000 or size>512*1024**2 or total>4*1024**3:raise ValueError("Runtime size limit exceeded")
            executable=bool(actual.stat().st_mode & stat.S_IXUSR)
            rows.append({"path":name,"size":size,"sha256":sha256(actual),"executable":executable})
            info=zipfile.ZipInfo(name);info.create_system=3;info.external_attr=((stat.S_IFREG|(0o700 if executable else 0o600))<<16);info.compress_type=zipfile.ZIP_DEFLATED
            with actual.open("rb") as src,z.open(info,"w",force_zip64=True) as dst:shutil.copyfileobj(src,dst,1024*1024)
        manifest=json.dumps({"schema":1,"target":target,"version":"0.7.1","files":rows},separators=(",",":")).encode("utf-8")
        z.writestr("runtime-files.json",manifest)
    return {"name":output.name,"sha256":sha256(output),"size":output.stat().st_size,"unpackedSize":total,"fileCount":len(rows),"manifestSha256":hashlib.sha256(manifest).hexdigest()}

def unpack_installable(archive,dest,target):
    with zipfile.ZipFile(archive) as z:
        m=json.loads(z.read("runtime-files.json"));rows=m["files"]
        if m["target"]!=target or m["version"]!="0.7.1" or m["schema"]!=1:raise ValueError("Runtime manifest mismatch")
        names=[r["path"] for r in rows]
        if len(names)!=len(set(runtime_member(name,target) for name in names)) or len(z.namelist())!=len(names)+1 or set(z.namelist())!=set(names+["runtime-files.json"]):raise ValueError("Runtime file list mismatch")
        for r in rows:
            path=dest/r["path"];path.parent.mkdir(parents=True,exist_ok=True)
            if z.getinfo(r["path"]).file_size!=r["size"]:raise ValueError("Runtime file size mismatch")
            with z.open(r["path"]) as src,path.open("xb") as dst:shutil.copyfileobj(src,dst,1024*1024)
            if sha256(path)!=r["sha256"]:raise ValueError("Runtime file digest mismatch")
            path.chmod(0o700 if r["executable"] else 0o600)

def build(args):
    target=host_target()
    if target not in PINS["targets"]:raise RuntimeError("Unsupported native build host: "+target)
    if args.target and args.target!=target:raise RuntimeError("Host architecture does not match requested target")
    pin=PINS["targets"][target]
    output=args.output.resolve();output.mkdir(parents=True,exist_ok=False)
    reportdir=output/"reports";reportdir.mkdir()
    with tempfile.TemporaryDirectory(prefix="br-babeldoc-build-") as scratch:
        root=Path(scratch);home=root/"isolated home";first=root/"first runtime";first.mkdir()
        name=f'cpython-{PINS["python"]["version"]}+{PINS["python"]["release"]}-{pin["triple"]}-install_only.tar.gz'
        url=f'https://github.com/astral-sh/python-build-standalone/releases/download/{PINS["python"]["release"]}/'+urllib.parse.quote(name,safe="")
        archive=root/"python.tar.gz";checked_download(url,archive,pin["pythonSize"],pin["pythonSha256"])
        safe_extract(archive,first);py=py_path(first)
        pip=[py,"-I","-X","utf8","-m","pip","--isolated","--disable-pip-version-check","--no-input"]
        report=root/"resolve.json"
        run(pip+["install","--index-url",INDEX,"--dry-run","--ignore-installed","--only-binary=:all:","--report",report,"BabelDOC==0.7.1"],home)
        text,deps=lock_from_report(report,target)
        lock=reportdir/"requirements.lock";lock.write_bytes(text.encode("utf-8"))
        verify_lock(text,target)
        (reportdir/"dependencies.json").write_text(json.dumps(deps,indent=2),encoding="utf-8")
        wheels=root/"wheels";wheels.mkdir()
        run(pip+["download","--index-url",INDEX,"--only-binary=:all:","--require-hashes","--no-deps","-r",lock,"-d",wheels],home)
        expected={d["wheel"]:d["sha256"] for d in deps}
        if {p.name for p in wheels.iterdir()}!=set(expected) or any(sha256(p)!=expected[p.name] for p in wheels.iterdir()):raise ValueError("Wheelhouse mismatch")
        # Build a candidate, then extract/install it in an independent Unicode path.
        package=output/("babeldoc-0.7.1-"+target+"-candidate.zip")
        pack_candidate(package,archive,wheels,lock)
        relocated=root/"second runtime 测试 with spaces";relocated.mkdir()
        with zipfile.ZipFile(package) as z:z.extractall(relocated) # locally generated package, exact member names
        if sha256(relocated/"python.tar.gz")!=pin["pythonSha256"]:raise ValueError("Relocated interpreter mismatch")
        safe_extract(relocated/"python.tar.gz",relocated);py2=py_path(relocated)
        pip2=[py2,"-I","-X","utf8","-m","pip","--isolated","--disable-pip-version-check","--no-input"]
        run(pip2+["install","--no-index","--find-links",relocated/"wheels","--only-binary=:all:","--require-hashes","--no-deps","--no-compile","--target",relocated/"site","-r",relocated/"requirements.lock"],root/"second home")
        run([py2,"-I","-X","utf8",relocated/"launcher.py","--home",root/"probe home","probe"],root/"probe home")
        installable=None
        if args.installer_candidate:
            flat=output/("babeldoc-0.7.1-"+target+"-runtime-candidate.zip")
            installable=pack_installable(relocated,flat,target)
            third=root/"installed runtime 测试";third.mkdir()
            unpack_installable(flat,third,target)
            run([py_path(third),"-I","-X","utf8",third/"launcher.py","--home",root/"third probe home","probe"],root/"third probe home")
            installable["relocationProbe"]=True
        assets=None
        if args.assets:
            assetdir=output/"assets";assetdir.mkdir()
            run([py2,"-I","-X","utf8",relocated/"launcher.py","--home",root/"asset generation home","generate-assets","--assets",assetdir],root/"asset generation home",1800)
            found=list(assetdir.glob("offline_assets_*.zip"))
            if len(found)!=1:raise RuntimeError("Expected one official offline assets archive")
            assets=found[0]
            run([py2,"-I","-X","utf8",relocated/"launcher.py","--home",root/"fresh offline home","verify-assets","--assets",assets],root/"fresh offline home",1800)
        manifest={"schema":1,"status":"candidate-not-approved-for-distribution","target":target,
                  "babeldoc":PINS["babeldoc"],"python":PINS["python"],"pythonSha256":pin["pythonSha256"],
                  "runtime":{"name":package.name,"sha256":sha256(package),"size":package.stat().st_size},
                  "dependencyLockSha256":sha256(lock),"relocationProbe":True,"installerCandidate":installable,
                  "offlineAssets":None if not assets else {"name":assets.name,"sha256":sha256(assets),"size":assets.stat().st_size,"verified":True},
                  "releaseBlockers":["review and commit resolved dependency lock","dependency vulnerability and license review","model/font redistribution review","real PDF translation on target OS","installer validation"]}
        (reportdir/"manifest.json").write_text(json.dumps(manifest,indent=2),encoding="utf-8")
        print(json.dumps(manifest,indent=2))
if __name__=="__main__":
    p=argparse.ArgumentParser()
    p.add_argument("--output",type=Path,required=True)
    p.add_argument("--target",choices=list(PINS["targets"]))
    p.add_argument("--assets",action="store_true")
    p.add_argument("--installer-candidate",action="store_true")
    build(p.parse_args())
