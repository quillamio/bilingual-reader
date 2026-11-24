/**
 * Client for Zotero PDF2zh's local /translate and task/download protocol.
 * The installed upstream server runs pdf2zh_next/BabelDOC and assembles LR output.
 * Upstream (AGPL-3.0): https://github.com/guaguastandup/zotero-pdf2zh
 */
const ENDPOINT_PREF = "extensions.zotero.bilingualreader.pdf2zh.url";
const UPSTREAM_PREFS = "extensions.zotero.pdf2zh.";
const DEFAULT_ENDPOINT = "http://127.0.0.1:8890";
const MAX_PDF_BYTES = 100 * 1024 * 1024;

interface Job {
  status?: string;
  taskId?: string;
  progress?: number;
  finished?: boolean;
  fileList?: string[];
  result?: Job;
}

export function validatePDF2zhEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch (_) { throw new Error("请输入本机 PDF2zh 服务地址，例如 " + DEFAULT_ENDPOINT + "。"); }
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.port || Number(url.port) < 1024 || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error("PDF2zh 仅允许连接本机 HTTP 服务，请填写服务根地址和端口。");
  }
  return url.origin;
}

export function getPDF2zhEndpoint(): string {
  const custom = Zotero.Prefs.get(ENDPOINT_PREF, true);
  const upstream = Zotero.Prefs.get(UPSTREAM_PREFS + "new_serverip", true);
  for (const value of [custom, upstream]) {
    if (typeof value !== "string" || !value.trim()) continue;
    try { return validatePDF2zhEndpoint(value); }
    catch (_) { /* Ignore old, non-loopback preferences. */ }
  }
  return DEFAULT_ENDPOINT;
}

export function setPDF2zhEndpoint(value: string): void {
  Zotero.Prefs.set(ENDPOINT_PREF, value.trim() ? validatePDF2zhEndpoint(value) : "", true);
}

export function getPDF2zhService(): string {
  const service = Zotero.Prefs.get(UPSTREAM_PREFS + "next_service", true);
  return typeof service === "string" && /^[a-z][a-z0-9_-]{2,40}$/u.test(service) ? service : "bing";
}

async function request(method: "GET" | "POST", url: string,
  responseType: "json" | "arraybuffer" = "json", body?: unknown): Promise<any> {
  const xhr = await Zotero.HTTP.request(method, url, {
    responseType, noCache: true, followRedirects: false, timeout: body ? 30000 : 15000,
    errorDelayMax: 0,
    headers: body ? {
      "Content-Type": "application/json",
      "X-PDF2zh-Protocol": "accepted",
    } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  } as any);
  if (xhr.status < 200 || xhr.status >= 300) throw new Error("HTTP " + xhr.status);
  return xhr.response;
}

export async function checkPDF2zhConnection(endpoint = getPDF2zhEndpoint()): Promise<string> {
  let reply: any;
  try { reply = await request("GET", validatePDF2zhEndpoint(endpoint) + "/health"); }
  catch (_) { throw new Error("连接不到本机 PDF2zh 服务。请启动 Zotero PDF2zh 的 server.py，或检查服务地址。"); }
  if (reply?.status !== "ok" || !/pdf2zh/iu.test(String(reply.message)) ||
      !/^\d+\.\d+/u.test(String(reply.version))) {
    throw new Error("该地址未返回 Zotero PDF2zh 的服务标识。");
  }
  return String(reply.version);
}

function encodePDF(pdf: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < pdf.length; i += 32768) {
    parts.push(String.fromCharCode(...pdf.subarray(i, i + 32768)));
  }
  return Zotero.getMainWindow().btoa(parts.join(""));
}

function selectResult(job: Job, stem: string): string {
  const files = job.result?.fileList ?? job.fileList;
  const result = Array.isArray(files) && files.find((name) => typeof name === "string" &&
    name.startsWith(stem + ".") && /^[\w.-]+$/u.test(name) && /\.(?:LR_dual|dual)\.pdf$/iu.test(name));
  if (!result) throw new Error("PDF2zh 未返回本次任务的左右双栏 PDF。");
  return result;
}

async function waitForJob(endpoint: string, taskId: string, onProgress: (message: string) => void): Promise<Job> {
  const until = Date.now() + 90 * 60 * 1000;
  let consecutiveErrors = 0;
  while (Date.now() < until) {
    let job: Job | undefined;
    try {
      const active = await request("GET", endpoint + "/api/tasks");
      job = Array.isArray(active?.tasks) ? active.tasks.find((row: Job) => row?.taskId === taskId) : undefined;
      if (!job) {
        const history = await request("GET", endpoint + "/api/history");
        job = Array.isArray(history?.history) ? history.history.find((row: Job) => row?.taskId === taskId) : undefined;
      }
      consecutiveErrors = 0;
    } catch (_) {
      if (++consecutiveErrors >= 4) throw new Error("读取 PDF2zh 任务进度失败。任务可能仍在服务端运行。");
    }
    if (job?.status === "完成" || job?.status === "success" || job?.result?.status === "success") return job;
    if (job?.finished || ["error", "failed", "cancelled", "失败", "已取消"].includes(job?.status || "")) {
      throw new Error("PDF2zh 排版翻译任务失败。可在本机 PDF2zh 服务页面查看失败原因。");
    }
    const percent = Number(job?.progress);
    onProgress(Number.isFinite(percent) ? `PDF2zh 正在翻译和排版 · ${Math.max(0, Math.min(100, percent))}%` : "PDF2zh 正在翻译和排版…");
    await Zotero.Promise.delay(1500);
  }
  throw new Error("等待 PDF2zh 超时。请先在本机服务页面查看任务状态。");
}

export async function generatePDF2zhDualPDF(
  pdf: Uint8Array, skipLastPages: number, onProgress: (message: string) => void,
  endpoint = getPDF2zhEndpoint(), service = getPDF2zhService(),
): Promise<Uint8Array> {
  const base = validatePDF2zhEndpoint(endpoint);
  if (pdf.length < 5 || pdf.length > MAX_PDF_BYTES) throw new Error("PDF2zh 导出支持最多 100 MB 的 PDF。");
  await checkPDF2zhConnection(base);
  const stem = `br-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  onProgress("正在提交 PDF2zh 左右双栏任务…");
  let job: Job;
  try {
    job = await request("POST", base + "/translate", "json", {
      fileName: stem + ".pdf",
      fileContent: encodePDF(pdf),
      asyncJob: true,
      engine: "pdf2zh_next",
      next_service: service,
      sourceLang: "en",
      targetLang: "zh-CN",
      skipLastPages,
      qps: 2,
      dualMode: "LR",
      transFirst: false,
      dual: true,
      mono: false,
      noMono: true,
      noWatermark: true,
      disableGlossary: true,
    });
  } catch (_) {
    throw new Error("提交 PDF2zh 任务失败。请查看本机服务的任务记录，再决定是否重试。");
  }
  if (job?.status !== "success") {
    if (job?.status !== "accepted" || typeof job.taskId !== "string" || !job.taskId) {
      throw new Error("PDF2zh 未接受左右双栏任务。请检查本机服务配置。");
    }
    job = await waitForJob(base, job.taskId, onProgress);
  }
  const filename = selectResult(job, stem);
  onProgress("正在下载 PDF2zh 双栏 PDF…");
  const received = await request("GET", base + "/translatedFile/" + encodeURIComponent(filename), "arraybuffer");
  const bytes = new Uint8Array(received);
  if (bytes.length < 5 || bytes.length > MAX_PDF_BYTES * 2 ||
      String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") {
    throw new Error("PDF2zh 返回的文件不是有效的 PDF，已停止导入。");
  }
  const { PDFDocument } = await import("pdf-lib");
  if (!(await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount()) {
    throw new Error("PDF2zh 返回的 PDF 没有页面。");
  }
  return bytes;
}
