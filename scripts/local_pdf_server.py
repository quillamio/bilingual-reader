"""Authenticated loopback bridge. Only fixed engine/output options are accepted."""
import argparse
import hmac
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit, parse_qs

MAX_INPUT = 30 * 1024 * 1024
MAX_OUTPUT = 150 * 1024 * 1024
ENGINES = {"babeldoc": ("babeldoc", "BR_BABELDOC_CONFIG", "--config"),
           "pdf2zh-next": ("pdf2zh_next", "BR_PDF2ZH_CONFIG", "--config-file")}

def command(engine, mode, source, output, config):
    executable, _, config_flag = ENGINES[engine]
    binary = shutil.which(executable)
    if not binary:
        raise RuntimeError("Engine not installed")
    args = [binary, config_flag, str(config)]
    args += ["--files", str(source)] if engine == "babeldoc" else [str(source)]
    args += ["--output", str(output), "--lang-in", "en", "--lang-out", "zh-CN"]
    args += ["--no-dual"] if mode == "mono" else ["--no-mono"]
    return args

def translated_pdf(engine, mode, data):
    _, env, _ = ENGINES[engine]
    config = Path(os.environ.get(env, "")).expanduser()
    if not config.is_file():
        raise RuntimeError("Missing engine configuration")
    with tempfile.TemporaryDirectory(prefix="br-pdf-") as root:
        root = Path(root)
        source = root / "document.pdf"
        source.write_bytes(data)
        output = root / "out"
        output.mkdir()
        subprocess.run(command(engine, mode, source, output, config.resolve()),
                       cwd=root, shell=False, check=True, timeout=1800,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       stdin=subprocess.DEVNULL)
        candidates = [p for p in output.glob("*.pdf") if re.search(r"[.-]"+mode+r"\.pdf$", p.name, re.I)
                      and p.is_file() and not p.is_symlink()]
        if len(candidates) != 1:
            raise RuntimeError("Expected one output; check watermark/output settings")
        result = candidates[0]
        if not 16 <= result.stat().st_size <= MAX_OUTPUT:
            raise RuntimeError("Invalid output size")
        data = result.read_bytes()
        if not data.startswith(b"%PDF-") or not data.rstrip().endswith(b"%%EOF"):
            raise RuntimeError("Invalid PDF")
        return data

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    def log_message(self, *args):
        pass
    def reply(self, status, data, content_type="text/plain; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass
    def authenticated(self):
        return hmac.compare_digest(self.headers.get("Authorization", "").encode(),
                                   ("Bearer " + self.server.token).encode())
    def do_GET(self):
        if not self.authenticated():
            self.reply(401,b"Unauthorized")
        elif self.path == "/health":
            self.reply(200,b'{"service":"bilingual-reader-localpdf","version":1}',"application/json")
        else:
            self.reply(404,b"Not found")
    def do_POST(self):
        if not self.authenticated():
            self.reply(401,b"Unauthorized")
            return
        parsed = urlsplit(self.path)
        params = parse_qs(parsed.query)
        if set(params) != {"engine", "output"} or any(len(values) != 1 for values in params.values()):
            self.reply(400,b"Invalid parameters")
            return
        engine = params.get("engine", [""])[0]
        mode = params.get("output", [""])[0]
        if parsed.path != "/translate" or engine not in ENGINES or mode not in ("mono", "dual"):
            self.reply(400,b"Invalid engine or output")
            return
        try:
            length = int(self.headers.get("Content-Length","0"))
        except ValueError:
            length = 0
        if not 16 <= length <= MAX_INPUT or self.headers.get("Content-Type") != "application/pdf":
            self.reply(413,b"Invalid input")
            return
        self.connection.settimeout(60)
        try:
            data = self.rfile.read(length)
            if len(data) != length or not data.startswith(b"%PDF-"):
                self.reply(400,b"Invalid PDF")
                return
            result = translated_pdf(engine,mode,data)
            self.reply(200,result,"application/pdf")
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError, OSError, RuntimeError):
            self.reply(502,b"Local engine failed; inspect local configuration")
def main():
    p=argparse.ArgumentParser()
    p.add_argument("--port",type=int,default=8787)
    args=p.parse_args()
    token=os.environ.get("BR_LOCALPDF_TOKEN","")
    if not re.fullmatch(r"[A-Za-z0-9_-]{24,128}",token):
        p.error("Set BR_LOCALPDF_TOKEN to a strong random token")
    if not 1024<=args.port<=65535:
        p.error("Invalid port")
    server=HTTPServer(("127.0.0.1",args.port),Handler)
    server.token=token
    print("Bilingual Reader local PDF bridge listening on 127.0.0.1",flush=True)
    server.serve_forever()
if __name__=="__main__":
    main()
