/**
 * Optional Docling local sidecar. The plugin never uploads a PDF to a public
 * cloud; only an explicitly enabled loopback endpoint is permitted.
 * The sidecar enriches reading order and block types; original page images
 * always come from PDF.js, never from a Docling HTML/Markdown export.
 */
import { validateNativeDocument, type NativeDocument, type NativeParser } from "./pdfNativeModel";
import { isCloudParser } from "./pdfCloudModel";

const ROOT = "extensions.zotero.bilingualreader";
const DEFAULT_URL = "http://127.0.0.1:8786";
export function getNativePDFBackend(): NativeParser {
  const selected = (Zotero.Prefs as any).get(ROOT + ".native.backend", true);
  return selected === "docling" || isCloudParser(selected) ? selected : "pdfjs";
}
export function setNativePDFBackend(value: NativeParser): void {
  (Zotero.Prefs as any).set(ROOT + ".native.backend", value, true);
}
export function getDoclingEndpoint(): string {
  const raw = (Zotero.Prefs as any).get(ROOT + ".native.doclingURL", true);
  const value = typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_URL;
  return value.replace(/\/+$/u, "");
}
export function validateDoclingEndpoint(endpoint: string): string {
  let url: URL;
  try { url = new URL(endpoint); }
  catch (_) { throw new Error("Docling 地址必须是有效的本地 HTTP URL。"); }
  if (url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !!url.username || !!url.password || url.search || url.hash ||
    !url.port || Number(url.port) < 1024 || Number(url.port) > 65535) {
    throw new Error("Docling 仅允许连接本机 HTTP 服务（localhost/127.0.0.1，端口 1024–65535）。");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("Docling 地址应为服务根地址，不包含 API 路径。");
  }
  return url.origin;
}
export function setDoclingEndpoint(value: string): void {
  (Zotero.Prefs as any).set(ROOT + ".native.doclingURL",
    validateDoclingEndpoint(value), true);
}
function encodeBytesBase64(bytes: Uint8Array): string {
  const encode = (Zotero.getMainWindow() as any).btoa;
  if (typeof encode !== "function") throw new Error("Zotero 当前窗口不支持 Base64 编码。");
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += 32768) {
    const slice = bytes.subarray(index, index + 32768);
    parts.push(String.fromCharCode(...slice));
  }
  return encode(parts.join(""));
}
export async function checkDoclingConnection(endpoint: string): Promise<boolean> {
  const base = validateDoclingEndpoint(endpoint);
  const result = await Zotero.HTTP.request("GET", base + "/health", {
    responseType: "json", timeout: 5000,
    headers: { "X-Bilingual-Reader": "1" },
  });
  const raw = typeof result.response === "string"
    ? JSON.parse(result.response) : result.response;
  return result.status === 200 && raw?.service === "bilingual-reader-docling";
}
export async function parseWithLocalDocling(
  pdfBytes: Uint8Array,
  endpoint: string,
  fallback: NativeDocument,
): Promise<NativeDocument> {
  if (pdfBytes.length < 4 || pdfBytes.length > 30 * 1024 * 1024) {
    throw new Error("Docling 只支持大小介于 4 字节到 30 MB 的 PDF。");
  }
  const base = validateDoclingEndpoint(endpoint);
  const xhr = await Zotero.HTTP.request("POST", base + "/parse", {
    headers: {
      "Content-Type": "application/json",
      "X-Bilingual-Reader": "1",
    },
    body: JSON.stringify({
      pdf_base64: encodeBytesBase64(pdfBytes),
      expected_pages: fallback.pages.length,
      ocr: false,
    }),
    responseType: "json",
    timeout: 300000,
  });
  if (xhr.status !== 200) throw new Error("Docling 解析失败：HTTP " + xhr.status);
  const raw = typeof xhr.response === "string"
    ? JSON.parse(xhr.response) : xhr.response;
  const enriched = validateNativeDocument(raw, "docling");
  if (enriched.pages.length !== fallback.pages.length) {
    throw new Error("Docling 返回页数与原始 PDF.js 不一致，已拒绝覆盖页面顺序。");
  }
  if (!enriched.pages.some((page) => page.blocks.some((block) => block.text.trim()))) {
    throw new Error("Docling 未返回可用的分页文本。");
  }
  const pageMap = new Map(enriched.pages.map((page) => [page.index, page]));
  if (pageMap.size !== fallback.pages.length) throw new Error("Docling 页面编号不唯一。");
  return {
    source: "docling",
    pages: fallback.pages.map((page) => {
      const doclingPage = pageMap.get(page.index);
      if (!doclingPage) throw new Error("Docling 页面缺失：" + (page.index + 1));
      return {
        index: page.index, width: page.width, height: page.height,
        // Preserve PDF.js text as fallback for empty Docling pages.
        blocks: doclingPage.blocks.length ? doclingPage.blocks : page.blocks,
      };
    }),
    warnings: [
      ...fallback.warnings.filter((w) => !/未提取到可翻译文本/u.test(w)),
      ...enriched.warnings,
    ],
  };
}
