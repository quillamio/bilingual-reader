/** Official BelinDoc document API. Transport is injected for offline tests. */
export type BelinResponse = "json" | "text" | "arraybuffer";
export type BelinRequest = (method: "POST" | "PUT" | "GET", url: string, headers: Record<string,string>, body: string | ArrayBuffer | undefined, response: BelinResponse) => Promise<unknown>;
export const BELIN_BASE = "https://belindoc.com/api/external/";
export const BELIN_MAX_BYTES = 30 * 1024 * 1024;
export const BELIN_OUTPUT_LIMIT = 150 * 1024 * 1024;
export type BelinLayout = "stacked" | "side-by-side" | "translation";
export const outputType = (layout: BelinLayout): number => layout === "side-by-side" ? 3 : layout === "stacked" ? 4 : 2;
export function belinData(value: any): any {
  if (String(value?.code) !== "200") {
    const code = String(value?.code || "");
    const messages: Record<string,string> = {"30306":"API Key 无效","30307":"API Key 已禁用","30308":"API Key 已过期","30309":"IP 不在白名单","30312":"API Key 已封禁"};
    throw new Error("BelinDoc：" + (messages[code] || "服务拒绝请求，请检查额度、模型和任务历史") + (/^\d{3,8}$/u.test(code) ? "（" + code + "）" : ""));
  }
  return value.data;
}
export function signedBelinURL(value: unknown): string {
  let url: URL;
  try { url = new URL(String(value)); } catch (_) { throw new Error("BelinDoc 返回无效存储地址。"); }
  const allowed = ["belindoc.com","amazonaws.com","amazonaws.com.cn","aliyuncs.com","myqcloud.com","r2.cloudflarestorage.com"];
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !allowed.some(s => url.hostname === s || url.hostname.endsWith("." + s))) {
    throw new Error("BelinDoc 返回未经允许的存储地址。");
  }
  return url.href;
}
export function belinDownloadURL(sse: unknown, order: string): string {
  if (typeof sse !== "string" || sse.length > 1000000) throw new Error("BelinDoc 下载事件无效。");
  for (const event of sse.replace(/\r\n/gu, "\n").split("\n\n")) {
    const lines = event.split("\n");
    if (!lines.some(line => /^event:\s*\[DONE\]\s*$/u.test(line))) continue;
    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    let parsed: any;
    try { parsed = JSON.parse(data); } catch (_) { throw new Error("BelinDoc 下载事件解析失败。"); }
    if (parsed.translateOrderNo && parsed.translateOrderNo !== order) throw new Error("BelinDoc 下载任务不匹配。");
    return signedBelinURL(parsed.url);
  }
  throw new Error("BelinDoc 未返回完成下载事件。");
}
export function checkBelinPDF(bytes: Uint8Array): void {
  if (bytes.length < 16 || bytes.length > BELIN_OUTPUT_LIMIT || new TextDecoder().decode(bytes.slice(0,8)).indexOf("%PDF-") !== 0 ||
      !/%%EOF\s*$/u.test(new TextDecoder().decode(bytes.slice(-2048)))) throw new Error("BelinDoc 下载结果不是完整 PDF 或超过容量上限。");
}
export interface BelinOptions {
  key: string; model: string; layout: BelinLayout; ocr: "auto" | "off" | "on";
  progress?: (stage: string) => void; check: () => void; wait: (ms: number) => Promise<void>;
  confirmSubmit: (info: {model: string; coefficient: number; ocr: boolean; freePages: number | undefined; quota: number | undefined}) => boolean;
  maxPolls?: number;
}
function objectString(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) throw new Error("BelinDoc 返回的任务标识无效。");
  return value;
}
export async function translateBelinPDF(request: BelinRequest, source: Uint8Array, options: BelinOptions): Promise<Uint8Array | undefined> {
  const { key, model, layout, ocr, progress, check, wait, confirmSubmit } = options;
  if (!/^ft_[A-Za-z0-9_-]+$/u.test(key)) throw new Error("请配置 BelinDoc Developer Center 的 API Key。");
  if (!source.length || source.length > BELIN_MAX_BYTES) throw new Error("BelinDoc 当前插件限制为 30 MB。");
  const api = async (endpoint: string, payload: unknown, format: BelinResponse = "json") => {
    check();
    const response = await request("POST", BELIN_BASE + endpoint, {"X-Api-Key":key,"Content-Type":"application/json",Accept:format === "text" ? "text/event-stream" : "application/json"}, JSON.stringify(payload), format);
    check();
    return format === "json" ? belinData(response) : response;
  };
  progress?.("查询模型和账户额度");
  const models = await api("translate/getModelList",{});
  if (!Array.isArray(models)) throw new Error("BelinDoc 模型列表格式异常。");
  const selected = models.find(m => m?.version === model);
  if (!selected) throw new Error("BelinDoc 模型不可用，请根据官方模型列表更新设置。");
  const coefficient = Number(selected.coefficient);
  if (!Number.isFinite(coefficient) || coefficient <= 0) throw new Error("BelinDoc 模型额度系数无效。");
  const wallet = await api("user/getMyWalletInfo",{});
  const plan = await api("user/getMySubscriptionInfo",{});
  const sizeLimit = Number(plan?.uploadFileSize);
  if (sizeLimit > 0 && source.length > sizeLimit * 1024 * 1024) throw new Error("文件超过 BelinDoc 账户上传上限。");
  // Never upload the real attachment name or library identity.
  const fileName = "document.pdf";
  progress?.("获取上传授权");
  const uploads = await api("translate/batchPresignedUploadUrl",{fileNameList:[fileName]});
  if (!Array.isArray(uploads) || uploads.length !== 1) throw new Error("BelinDoc 上传授权格式异常。");
  const upload = uploads[0], objectKey = objectString(upload.objectKey);
  const url = signedBelinURL(upload.persignedUploadUrl);
  check(); progress?.("上传原始 PDF");
  await request("PUT",url,{},source.slice().buffer as ArrayBuffer,"text");
  check();
  let scan = ocr === "on";
  if (ocr === "auto") {
    const storageType = Number(upload.storageType);
    if (!Number.isInteger(storageType)) throw new Error("BelinDoc 存储类型无效。");
    const detected = await api("translate/isOcr",{fileObjectKey:objectKey,storageType});
    if (![0,1].includes(detected?.isOcr)) throw new Error("BelinDoc OCR 检测结果无效。");
    scan = detected.isOcr === 1 && detected.isDoubleDeck !== 1;
  }
  const finite = (x: unknown) => typeof x === "number" && Number.isFinite(x) ? x : undefined;
  const freeTotal = finite(wallet?.totalFreeTranslateQuota), freeUsed = finite(wallet?.useFreeTranslateQuota);
  check();
  if (!confirmSubmit({model,coefficient,ocr:scan,freePages:freeTotal !== undefined && freeUsed !== undefined ? Math.max(0,freeTotal-freeUsed):undefined,quota:finite(wallet?.translateQuota)})) return undefined;
  progress?.("提交云端翻译（仅一次）");
  const submitted = await api("translate/batchSubmitTranslateTask",{fileList:[{fileName,fileObjectKey:objectKey,isOcrFile:scan?1:0}],sourceLanguage:"AnyLanguage",targetLanguage:"zh-CN",model,isOcr:scan?1:0,isMath:1});
  const batchNo = objectString(submitted?.batchNo);
  let order = "";
  for (let i=0;i<(options.maxPolls ?? 180);i++) {
    check();
    const tasks = await api("translate/searchTranslateFileByBatchNo",{batchNo});
    if (!Array.isArray(tasks) || tasks.length > 1) throw new Error("BelinDoc 返回不匹配的批次任务。");
    const current = tasks[0];
    if (current) {
      if (current.batchNo !== batchNo || current.sourceFileName !== fileName) throw new Error("BelinDoc 返回不匹配的文档任务。");
      const status = Number(current.status);
      if (status===3) { order=objectString(current.translateOrderNo); break; }
      if (status===4 || status===5) throw new Error("BelinDoc 云端任务失败或取消，请查看服务历史。");
      if (![0,1,2].includes(status)) throw new Error("BelinDoc 云端任务状态无效。");
      progress?.(["云端排队","云端解析","云端翻译"][status]);
    }
    await wait(5000);
  }
  if (!order) throw new Error("BelinDoc 等待超时；任务可能仍在云端执行，请先查看服务历史，避免重复扣费。");
  progress?.("获取双语 PDF 下载地址");
  const events = await api("translate/getTranslateS3DownloadUrl",{translateOrderNo:order,urlType:outputType(layout)},"text");
  const download = belinDownloadURL(events,order);
  check(); progress?.("下载并验证 PDF");
  const result = await request("GET",download,{},undefined,"arraybuffer");
  check();
  if (!(result instanceof ArrayBuffer) && Object.prototype.toString.call(result)!=="[object ArrayBuffer]") throw new Error("BelinDoc 下载响应无效。");
  const bytes = new Uint8Array(result as ArrayBuffer);
  checkBelinPDF(bytes);
  return bytes;
}
