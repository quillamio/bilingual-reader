#!/usr/bin/env python3
"""Opt-in local Docling sidecar for Bilingual Reader. MIT Docling dependency.

Install in a separate Python environment:
  python3 -m venv .venv-docling
  .venv-docling/bin/pip install docling
  .venv-docling/bin/python scripts/docling_local_server.py

By default this server binds exclusively to 127.0.0.1:8786. It never sends
documents to any web service. Docling may download its model weights on the
first run; see Docling documentation to configure an offline model cache.
No Zotero SDT reading-mode data is involved.
"""
from __future__ import annotations

import base64
import binascii
import io
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

HOST = "127.0.0.1"
PORT = int(os.environ.get("BR_DOCLING_PORT", "8786"))
MAX_PDF_BYTES = 30 * 1024 * 1024
MAX_REQUEST_BYTES = 41 * 1024 * 1024
_lock = threading.Lock()
_converter = None


def get_converter():
    global _converter
    if _converter is None:
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.document_converter import DocumentConverter, PdfFormatOption

        opts = PdfPipelineOptions()
        opts.do_ocr = False
        opts.do_table_structure = True
        opts.generate_page_images = False
        opts.generate_picture_images = False
        _converter = DocumentConverter(
            format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)}
        )
    return _converter


def box_to_rect(box, page_height):
    left, right = float(box.l), float(box.r)
    top, bottom = float(box.t), float(box.b)
    origin = str(getattr(box.coord_origin, "value", box.coord_origin)).upper()
    if "TOPLEFT" in origin:
        # Docling top-left: y grows down; normalize to PDF bottom-left.
        top, bottom = page_height - top, page_height - bottom
    return {
        "left": min(left, right),
        "right": max(left, right),
        "bottom": min(bottom, top),
        "top": max(bottom, top),
    }


def normalize_item_type(label):
    label = str(getattr(label, "value", label)).lower()
    if "title" in label or "header" in label:
        return "heading"
    if "caption" in label:
        return "caption"
    if "picture" in label or "figure" in label:
        return "picture"
    if "table" in label:
        return "table"
    if "formula" in label or "equation" in label:
        return "formula"
    if "footnote" in label:
        return "footnote"
    return "paragraph"


def convert_document(raw_pdf, expected_pages):
    from docling.datamodel.base_models import DocumentStream

    with _lock:
        converter = get_converter()
        stream = DocumentStream(name="zotero-original.pdf", stream=io.BytesIO(raw_pdf))
        result = converter.convert(stream)
        document = result.document

    page_data = {}
    for num, page in document.pages.items():
        ix = int(num) - 1
        page_data[ix] = {
            "index": ix,
            "width": float(page.size.width),
            "height": float(page.size.height),
            "blocks": [],
        }
    if expected_pages is not None and expected_pages != len(page_data):
        raise ValueError("Docling page count did not match the original PDF.")
    warnings = []
    for element, _level in document.iterate_items():
        provinces = list(getattr(element, "prov", []) or [])
        if not provinces:
            continue
        kind = normalize_item_type(getattr(element, "label", "text"))
        # For tables, retain a simple textual representation. The *original*
        # table geometry/artwork is still preserved by the PDF.js snapshot.
        value = getattr(element, "text", "") or ""
        if not value and kind == "table":
            try:
                value = element.export_to_markdown()
            except Exception:
                value = ""
        for prov in provinces:
            ix = int(prov.page_no) - 1
            page = page_data.get(ix)
            if page is None:
                continue
            rect = box_to_rect(prov.bbox, page["height"])
            blocks = page["blocks"]
            blocks.append({
                "id": f"docling:{ix}:{len(blocks)}",
                "pageIndex": ix,
                "order": len(blocks),
                "type": kind,
                "text": str(value).strip()[:50000],
                "bbox": rect,
            })
    for page in page_data.values():
        if not any(b["text"] for b in page["blocks"]):
            warnings.append(f"第 {page['index'] + 1} 页 Docling 未提取到文本，将回退到 PDF.js。")
    return {"source": "docling",
            "pages": [page_data[k] for k in sorted(page_data)],
            "warnings": warnings}


class Handler(BaseHTTPRequestHandler):
    server_version = "BilingualReaderDocling/1"
    def log_message(self, format, *args):
        # Do not put original paper text or request bodies in log files.
        print("[docling]", format % args)

    def respond(self, status, value):
        payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def authorized(self):
        # A website cannot attach this header without a preflight; the server
        # deliberately does not set CORS headers or support OPTIONS.
        return self.headers.get("X-Bilingual-Reader") == "1"

    def do_GET(self):
        if self.path == "/health" and self.authorized():
            self.respond(200, {"service": "bilingual-reader-docling", "status": "ok"})
        else:
            self.respond(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/parse" or not self.authorized():
            self.respond(403, {"error": "Forbidden"})
            return
        size = self.headers.get("Content-Length", "")
        if not size.isdigit() or int(size) < 4 or int(size) > MAX_REQUEST_BYTES:
            self.respond(413, {"error": "Request too large"})
            return
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            self.respond(415, {"error": "Expected JSON"})
            return
        try:
            data = json.loads(self.rfile.read(int(size)))
            text = data.get("pdf_base64")
            if not isinstance(text, str):
                raise ValueError("PDF base64 is missing")
            raw = base64.b64decode(text, validate=True)
            if not raw.startswith(b"%PDF-") or len(raw) > MAX_PDF_BYTES:
                raise ValueError("Only PDF files <=30MB are supported")
            expected = data.get("expected_pages")
            if not isinstance(expected, int) or expected < 1 or expected > 10000:
                raise ValueError("Expected pages must be a positive integer")
            parsed = convert_document(raw, expected)
            self.respond(200, parsed)
        except (ValueError, KeyError, binascii.Error):
            self.respond(400, {"error": "Invalid PDF or incompatible page structure"})
        except ImportError:
            self.respond(503, {"error": "Docling is not installed in this Python environment"})
        except Exception:
            self.respond(500, {"error": "Docling failed; inspect local server console"})

if __name__ == "__main__":
    if not (1024 <= PORT <= 65535):
        raise SystemExit("Port must be between 1024 and 65535")
    print(f"Local-only Docling service listening on http://{HOST}:{PORT}")
    HTTPServer((HOST, PORT), Handler).serve_forever()
