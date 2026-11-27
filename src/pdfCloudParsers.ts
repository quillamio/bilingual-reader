/**
 * Hosted parsing APIs, with independently stored credentials. Only explicit
 * user-selected cloud providers receive PDF bytes. Fixed official endpoints
 * prevent accidental key disclosure to arbitrary hosts.
 */
import type { NativeDocument } from "./pdfNativeModel";
import { PDF_DEADLINES, writeTemporaryWithDeadline, waitForPDFExport } from "./pdfOperationDeadline";
import { PDFExportCancelledError, type PDFExportTask } from "./pdfExportTask";
import { CLOUD_NAMES, normalizeMinerU, normalizeMarkdownPages, type CloudParser } from "./pdfCloudModel";

const PREF = "extensions.zotero.bilingualreader.native.cloud.";
const MAX_BYTES = 30 * 1024 * 1024;
export function getCloudKey(provider: CloudParser): string {
  const value = (Zotero.Prefs as any).get(PREF + provider + ".key", true);
  return typeof value === "string" ? value.trim() : "";
}
export function setCloudKey(provider: CloudParser, key: string): void {
  (Zotero.Prefs as any).set(PREF + provider + ".key", key.trim(), true);
}
export function getCloudModel(provider: CloudParser): string {
  const defaults = { mineru: "vlm", mistral: "mistral-ocr-latest", llamaparse: "agentic" };
  const value = (Zotero.Prefs as any).get(PREF + provider + ".model", true);
  return typeof value === "string" && value.trim() ? value.trim() : defaults[provider];
}
export function setCloudModel(provider: CloudParser, model: string): void {
  (Zotero.Prefs as any).set(PREF + provider + ".model", model.trim(), true);
}
function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
function base64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 32768) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
  }
  return Zotero.getMainWindow().btoa(parts.join(""));
}
function binary(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
async function request(method: "GET" | "POST" | "PUT", url: string,
  body?: ArrayBuffer, headers: Record<string, string> = {},
  responseType: "json" | "arraybuffer" | "text" = "json", timeout = 180000): Promise<any> {
  try {
    const xhr = await Zotero.HTTP.request(method, url, {
      body, headers, responseType, timeout, followRedirects: false,
      noCache: true, debug: false,
    } as any);
    if (xhr.status < 200 || xhr.status >= 300) throw new Error("HTTP " + xhr.status);
    return typeof xhr.response === "string" && responseType === "json"
      ? JSON.parse(xhr.response) : xhr.response;
  } catch (error: any) {
    // Never include original PDF content, secret, signed URL or provider body in errors.
    const status = Number(error?.status || error?.xmlhttp?.status || 0);
    throw new Error("PDF 解析服务请求失败" + (status >= 400 && status < 600 ? "（HTTP " + status + "）" : "（网络或响应异常）") + "。");
  }
}
function json(method: "GET" | "POST", url: string, key: string, payload?: unknown, timeout?: number): Promise<any> {
  return request(method, url, payload === undefined ? undefined : binary(encode(JSON.stringify(payload))),
    { Authorization: "Bearer " + key, "Content-Type": "application/json", Accept: "application/json" },
    "json", timeout);
}
function mineruData(result: any): any {
  if (result?.code === "A0202") throw new Error("MinerU Token 无效。");
  if (result?.code === "A0211") throw new Error("MinerU Token 已过期。");
  if (result?.code === -60018) throw new Error("MinerU 今日解析额度已用完。");
  if (result?.code !== 0 || !result.data) throw new Error("MinerU API 返回失败状态；请检查 Token 和额度。");
  return result.data;
}
function signedURL(value: unknown): string {
  const url = new URL(String(value || ""));
  // Storage destinations returned by the official MinerU v4 API.
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password ||
      (url.port && url.port !== "443") ||
      !["mineru.net", "mineru.io", "openxlab.org.cn", "aliyuncs.com"].some(
        suffix => host === suffix || host.endsWith("." + suffix))) {
    throw new Error("MinerU 返回不受支持的签名存储地址。");
  }
  return url.href;
}
async function readMinerUZip(buffer: ArrayBuffer, task?: PDFExportTask): Promise<unknown> {
  if (!buffer || buffer.byteLength < 4 || buffer.byteLength > 160 * 1024 * 1024) {
    throw new Error("MinerU ZIP 文件为空或超过 160 MB。");
  }
  const c = (globalThis as any).Components;
  if (!c?.classes || !c?.interfaces) throw new Error("Zotero ZIP 读取接口不可用。");
  const file = Zotero.getTempDirectory();
  file.append("br-mineru-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".zip");
  const zip = c.classes["@mozilla.org/libjar/zip-reader;1"].createInstance(c.interfaces.nsIZipReader);
  let opened = false;
  try {
    const stream = c.classes["@mozilla.org/io/arraybuffer-input-stream;1"]
      .createInstance(c.interfaces.nsIArrayBufferInputStream);
    stream.setData(buffer, 0, buffer.byteLength);
    await writeTemporaryWithDeadline("MinerU ZIP 临时文件写入", PDF_DEADLINES.fileWrite,
      () => (Zotero.File as any).putContentsAsync(file.path, stream),
      () => { if (file.exists()) file.remove(false); }, task);
    zip.open(file);
    opened = true;
    // Read only the bounded JSON entry, never unpack arbitrary archive paths.
    const matches = zip.findEntries("*content_list.json");
    const entries: string[] = [];
    while (matches.hasMore()) {
      entries.push(matches.getNext());
      if (entries.length > 32) throw new Error("MinerU ZIP 包含过多文档结果。");
    }
    if (entries.length !== 1) throw new Error("MinerU ZIP 缺少唯一的 content_list V1 JSON。");
    const size = Number(zip.getEntry(entries[0]).realSize);
    if (!Number.isFinite(size) || size < 2 || size > 24 * 1024 * 1024) {
      throw new Error("MinerU content_list 文件大小异常。");
    }
    const input = zip.getInputStream(entries[0]);
    const reader = c.classes["@mozilla.org/binaryinputstream;1"]
      .createInstance(c.interfaces.nsIBinaryInputStream);
    reader.setInputStream(input);
    try {
      const bytes = new Uint8Array(size);
      let offset = 0;
      while (offset < size) {
        const chunk = reader.readByteArray(Math.min(65536, size - offset));
        if (!chunk.length) throw new Error("MinerU JSON 读取不完整。");
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return JSON.parse(new TextDecoder().decode(bytes));
    } finally { reader.close(); }
  } finally {
    if (opened) zip.close();
    try { if (file.exists()) file.remove(false); } catch (_) { /* temporary file only */ }
  }
}
function cancelled(check?: () => boolean): void {
  if (check?.()) throw new Error("PDF 解析已取消。");
}
async function poll<T>(read: () => Promise<T | undefined>,
  check?: () => boolean, task?: PDFExportTask): Promise<T> {
  const deadline = Date.now() + 12 * 60 * 1000;
  while (Date.now() < deadline) {
    cancelled(check);
    const result = await read();
    cancelled(check);
    if (result !== undefined) return result;
    await waitForPDFExport(3000, task);
  }
  throw new Error("PDF 解析任务超时；请在服务商后台查看任务状态，避免重复计费。");
}
const MINERU_API = "https://mineru.net/api/v4";

function mineruToken(key: string): string {
  return key.replace(/^Bearer\s+/iu, "").trim();
}

async function requestMinerUUpload(token: string, model: string, name: string, timeout?: number):
  Promise<{ batchID: string; uploadURL: string }> {
  if (!token) throw new Error("请先填写 MinerU Token。");
  if (!["vlm", "pipeline"].includes(model)) throw new Error("MinerU 模型只能选择 vlm 或 pipeline。");
  const data = mineruData(await json("POST", MINERU_API + "/file-urls/batch", token, {
    files: [{ name, is_ocr: true }],
    model_version: model, enable_formula: true, enable_table: true, language: "en",
  }, timeout));
  if (typeof data.batch_id !== "string" || !data.batch_id || data.file_urls?.length !== 1) {
    throw new Error("MinerU 上传任务返回格式异常。");
  }
  return { batchID: data.batch_id, uploadURL: signedURL(data.file_urls[0]) };
}

export async function checkMinerUConnection(): Promise<void> {
  await requestMinerUUpload(mineruToken(getCloudKey("mineru")), getCloudModel("mineru"), "connection-test.pdf", 15000);
}

async function fetchMinerUStorage(url: string, body?: ArrayBuffer, task?: PDFExportTask): Promise<ArrayBuffer | undefined> {
  const win = Zotero.getMainWindow();
  task?.throwIfCancelled();
  const abort = new win.AbortController();
  const unsubscribe = task?.onCancel(() => abort.abort());
  const timer = setTimeout(() => abort.abort(), 180000);
  const stage = body ? "上传原始 PDF" : "下载解析结果";
  try {
    // An ArrayBuffer has no implicit media type in fetch. Zotero.HTTP adds a
    // form Content-Type to request bodies, which invalidates the signed PUT.
    const response = await win.fetch(url, {
      method: body ? "PUT" : "GET", body, credentials: "omit",
      redirect: "error", cache: "no-store", signal: abort.signal,
    });
    if (!response.ok) throw new Error("MinerU " + stage + "失败（HTTP " + response.status + "）。");
    if (!body) return await response.arrayBuffer();
  } catch (error) {
    if (task?.cancelled) throw new PDFExportCancelledError();
    const message = (error as Error).message;
    if (/^MinerU .*HTTP /u.test(message)) throw error;
    throw new Error("MinerU " + stage + "失败（网络或响应异常）。");
  } finally {
    unsubscribe?.();
    clearTimeout(timer);
  }
}

async function mineru(bytes: Uint8Array, key: string, model: string, base: NativeDocument,
  check?: () => boolean, task?: PDFExportTask): Promise<NativeDocument> {
  const token = mineruToken(key);
  const { batchID, uploadURL } = await requestMinerUUpload(token, model, "document.pdf");
  cancelled(check);
  await fetchMinerUStorage(uploadURL, binary(bytes), task);
  const resultURL = await poll<string>(async () => {
    const current = mineruData(await json("GET", MINERU_API + "/extract-results/batch/" +
      encodeURIComponent(batchID), token));
    const row = current.extract_result?.[0];
    if (row?.state === "failed") throw new Error("MinerU 解析任务失败。");
    return row?.state === "done" ? signedURL(row.full_zip_url) : undefined;
  }, check, task);
  cancelled(check);
  const zip = await fetchMinerUStorage(resultURL, undefined, task);
  if (!zip) throw new Error("MinerU 未返回解析文件。");
  cancelled(check);
  return normalizeMinerU(base, await readMinerUZip(zip, task));
}
async function mistral(bytes: Uint8Array, key: string, model: string,
  base: NativeDocument): Promise<NativeDocument> {
  const result = await json("POST", "https://api.mistral.ai/v1/ocr", key, {
    model, document: { type: "document_url", document_url: "data:application/pdf;base64," + base64(bytes) },
    include_image_base64: false,
  });
  return normalizeMarkdownPages(base, "mistral", result?.pages);
}
function multipart(bytes: Uint8Array): { body: ArrayBuffer; type: string } {
  const boundary = "BR" + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const head = encode("--" + boundary + "\r\nContent-Disposition: form-data; name=\"purpose\"\r\n\r\nparse\r\n--" +
    boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"document.pdf\"\r\nContent-Type: application/pdf\r\n\r\n");
  const tail = encode("\r\n--" + boundary + "--\r\n");
  const all = new Uint8Array(head.length + bytes.length + tail.length);
  all.set(head); all.set(bytes, head.length); all.set(tail, head.length + bytes.length);
  return { body: all.buffer, type: "multipart/form-data; boundary=" + boundary };
}
async function llamaparse(bytes: Uint8Array, key: string, model: string, base: NativeDocument,
  check?: () => boolean, task?: PDFExportTask): Promise<NativeDocument> {
  if (!["fast", "cost_effective", "agentic", "agentic_plus"].includes(model)) {
    throw new Error("LlamaParse tier 无效。");
  }
  const root = "https://api.cloud.llamaindex.ai";
  const form = multipart(bytes);
  const upload = await request("POST", root + "/api/v1/beta/files", form.body,
    { Authorization: "Bearer " + key, "Content-Type": form.type, Accept: "application/json" });
  if (typeof upload?.id !== "string") throw new Error("LlamaParse 未返回文件 ID。");
  cancelled(check);
  const job = await json("POST", root + "/api/v2/parse", key,
    { file_id: upload.id, tier: model, version: "latest" });
  if (typeof job?.id !== "string") throw new Error("LlamaParse 未返回任务 ID。");
  const result = await poll<any>(async () => {
    const data = await json("GET", root + "/api/v2/parse/" + encodeURIComponent(job.id) + "?expand=markdown", key);
    if (["FAILED", "CANCELLED"].includes(data?.job?.status)) throw new Error("LlamaParse 解析任务失败或取消。");
    return data?.job?.status === "COMPLETED" ? data : undefined;
  }, check, task);
  return normalizeMarkdownPages(base, "llamaparse", result?.markdown?.pages);
}
export async function parseWithCloudProvider(provider: CloudParser, bytes: Uint8Array,
  base: NativeDocument, check?: () => boolean, task?: PDFExportTask): Promise<NativeDocument> {
  const key = getCloudKey(provider);
  if (!key) throw new Error(CLOUD_NAMES[provider] + " 尚未配置 API Key。");
  if (bytes.length < 4 || bytes.length > MAX_BYTES) throw new Error("云端解析预览版仅支持不超过 30 MB 的 PDF。");
  cancelled(check);
  const model = getCloudModel(provider);
  switch (provider) {
    case "mineru": return mineru(bytes, key, model, base, check, task);
    case "mistral": return mistral(bytes, key, model, base);
    case "llamaparse": return llamaparse(bytes, key, model, base, check, task);
  }
}
