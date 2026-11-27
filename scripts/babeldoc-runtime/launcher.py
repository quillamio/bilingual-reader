"""Candidate runtime entrypoint. No dependency on a system Python or absolute shebang."""
import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import site
import socket
import sys
import zipfile
import hashlib

ROOT = Path(__file__).resolve().parent

def setup(home):
    home.mkdir(parents=True, exist_ok=True)
    os.environ["HOME"] = os.environ["USERPROFILE"] = str(home.resolve())
    os.environ["XDG_CACHE_HOME"] = str(home / ".cache")
    os.environ["HF_HOME"] = str(home / ".cache" / "huggingface")
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["DO_NOT_TRACK"] = "1"
    site.addsitedir(str(ROOT / "site"))

def deny_network():
    # Offline smoke-test tripwire for Python sockets. Not an OS sandbox.
    def blocked(*args, **kwargs):
        raise RuntimeError("Offline verification attempted network access")
    socket.create_connection = blocked
    socket.socket.connect = blocked
    socket.socket.connect_ex = blocked

def expected_assets():
    from babeldoc.assets.assets import generate_all_assets_file_list
    return {kind + "/" + row["name"]: row["sha3_256"]
            for kind, rows in generate_all_assets_file_list().items() for row in rows}

def verify_asset_zip(path):
    expected = expected_assets()
    with zipfile.ZipFile(path) as z:
        infos = z.infolist()
        names = [i.filename for i in infos]
        if len(names) != len(set(names)) or set(names) != set(expected):
            raise ValueError("Offline asset names mismatch")
        if sum(i.file_size for i in infos) > 4 * 1024**3:
            raise ValueError("Offline assets exceed size limit")
        for i in infos:
            # Unix symlinks, encrypted data, absolute/traversal paths are disallowed.
            if (i.external_attr >> 16) & 0o170000 == 0o120000 or i.flag_bits & 1:
                raise ValueError("Unsafe asset member")
            digest = hashlib.sha3_256()
            with z.open(i) as src:
                for chunk in iter(lambda: src.read(1024*1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() != expected[i.filename]:
                raise ValueError("Asset digest mismatch")
    return expected

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", required=True, type=Path)
    parser.add_argument("mode", choices=["probe", "generate-assets", "verify-assets"])
    parser.add_argument("--assets", type=Path)
    args = parser.parse_args()
    setup(args.home)
    if args.mode != "generate-assets":
        deny_network()
    import babeldoc
    import onnxruntime
    import pymupdf
    from babeldoc.assets.assets import (generate_offline_assets_package,
        restore_offline_assets_package, warmup, get_offline_assets_tag)
    from babeldoc.main import cli
    if importlib.metadata.version("BabelDOC") != "0.7.1":
        raise RuntimeError("Unexpected BabelDOC version")
    if args.mode == "generate-assets":
        if not args.assets:
            parser.error("assets directory required")
        generate_offline_assets_package(args.assets)
        path = args.assets / ("offline_assets_" + get_offline_assets_tag() + ".zip")
        print(json.dumps({"asset_file":path.name,"asset_count":len(verify_asset_zip(path))}))
    elif args.mode == "verify-assets":
        if not args.assets:
            parser.error("assets archive required")
        verify_asset_zip(args.assets)
        restore_offline_assets_package(args.assets)
        warmup()
        print(json.dumps({"offline_assets_verified":True,"asset_count":len(expected_assets())}))
    else:
        print(json.dumps({"babeldoc":importlib.metadata.version("BabelDOC"),"python":sys.version.split()[0],
            "onnxruntime":onnxruntime.__version__,"pymupdf":pymupdf.VersionBind,"cli_callable":callable(cli)}))

if __name__ == "__main__":
    main()
