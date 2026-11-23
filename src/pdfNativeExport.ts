/**
 * PDF.js bilingual export. Requires only Zotero's ordinary PDF view, never
 * Zotero SDT reading mode or #sdt-content. All source-page visual elements
 * are retained through full-page JPEG snapshots.
 */
import { getEngine, getCacheEngineTag, getMaxCharsPerRequest, getRequestGapMs,
  getSkipLastPages, getMaxConsecutiveErrors } from "./settings";
import { loadCachedTranslation, saveCachedTranslation } from "./translationCache";
import { buildBatchPayload, packBatchItems, parseBatchResult, splitTextForRequest,
  type BatchInput } from "./translationPipeline";
import { translateText } from "./bilingualReader";
import { printHTMLToPDF, importExportedPDF } from "./readerUI";
import { getNativePDFBackend, getDoclingEndpoint, parseWithLocalDocling } from "./pdfNativeDocling";
import { getNormalPDFProxy, parseNormalPDFWithPDFJS, snapshotPDFPage,
  getOriginalPDFBytes } from "./pdfNativeRuntime";
import { type NativeDocument, type NativeBlock } from "./pdfNativeModel";
import { buildNativeBilingualHTML, type NativeExportPage } from "./pdfNativeHtml";

const active = new WeakSet<object>();
const isFailure = (value: string) => !value.trim() ||
  /^\[请求错误\]|HTTP\s+\d{3}|此翻译服务不可用/iu.test(value.trim());
const canTranslate = (block: NativeBlock) =>
  block.text.length >= 2 &&
  ["paragraph", "heading", "caption", "table", "footnote"].includes(block.type);
function dialog(reader: any): any {
  return reader?._iframeWindow || Zotero.getMainWindow();
}
function notify(reader: any, message: string): void {
  const win = dialog(reader);
  if (typeof win?.alert === "function") win.alert(message);
  else Zotero.logError(new Error(message));
}
function confirm(reader: any, message: string): boolean {
  const win = dialog(reader);
  return typeof win?.confirm === "function" ? Boolean(win.confirm(message)) : true;
}
function progress(button: HTMLButtonElement | null, text: string): void {
  if (!button) return;
  button.title = text;
  button.setAttribute("aria-label", text);
}
async function translateSegment(
  text: string, itemID: number, engine: ReturnType<typeof getEngine>,
): Promise<{ text: string; tag: string }> {
  const chunks = splitTextForRequest(text, getMaxCharsPerRequest());
  const translated: string[] = [];
  let tag = getCacheEngineTag();
  for (const chunk of chunks) {
    const response = await translateText(chunk, itemID, engine);
    if (isFailure(response.text)) throw new Error("翻译服务返回无效内容。");
    translated.push(response.text);
    tag = response.engineTag;
    if (getRequestGapMs()) await Zotero.Promise.delay(getRequestGapMs());
  }
  return { text: translated.join(" ").trim(), tag };
}

export async function translateNativeDocument(
  document: NativeDocument,
  itemID: number,
  itemKey: string,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, string>> {
  const engine = getEngine();
  const engineTag = getCacheEngineTag();
  const cutoff = document.pages.length - getSkipLastPages();
  const pending: Array<NativeBlock & BatchInput> = [];
  const translated = new Map<string, string>();
  for (const page of document.pages) {
    if (page.index >= cutoff) continue;
    for (const block of page.blocks) {
      if (!canTranslate(block)) continue;
      const cached = loadCachedTranslation(itemKey, block.text, engineTag, isFailure);
      if (cached) translated.set(block.id, cached);
      else pending.push({ ...block, id: block.id, text: block.text });
    }
  }
  const jobs = packBatchItems(pending, getMaxCharsPerRequest(), 4);
  let done = 0;
  let consecutiveFailures = 0;
  for (const job of jobs) {
    let responses: Array<{ block: typeof pending[number]; result: string; tag: string }> = [];
    try {
      if (job.length === 1) {
        const response = await translateSegment(job[0].text, itemID, engine);
        responses = [{ block: job[0], result: response.text, tag: response.tag }];
      } else {
        const batch = await translateSegment(buildBatchPayload(job), itemID, engine);
        const unpacked = parseBatchResult(batch.text, job.length);
        if (unpacked) {
          responses = job.map((block, i) =>
            ({ block, result: unpacked[i], tag: batch.tag }));
        } else {
          // Some engines destroy our segment markers; safe one-by-one fallback.
          for (const block of job) {
            const response = await translateSegment(block.text, itemID, engine);
            responses.push({ block, result: response.text, tag: response.tag });
          }
        }
      }
      for (const { block, result, tag } of responses) {
        translated.set(block.id, result);
        saveCachedTranslation(itemKey, block.text, result, tag, isFailure);
      }
      consecutiveFailures = 0;
    } catch (error) {
      Zotero.logError(error as Error);
      consecutiveFailures++;
      if (consecutiveFailures >= getMaxConsecutiveErrors()) {
        throw new Error("连续翻译失败，停止生成不完整文件：" +
          String((error as Error)?.message || error));
      }
    }
    done += job.length;
    onProgress?.(done, pending.length);
    if (getRequestGapMs()) await Zotero.Promise.delay(getRequestGapMs());
  }
  return translated;
}

/** Export original PDF page + bilingual searchable text page per source page. */
export async function exportNativePDFBilingual(
  reader: any, button: HTMLButtonElement | null = null,
): Promise<void> {
  if (!reader || typeof reader !== "object" || active.has(reader)) return;
  active.add(reader);
  const oldTitle = button?.title || "PDF.js 原版双语导出";
  try {
    const handle = getNormalPDFProxy(reader);
    if (!handle) throw new Error(
      "未找到 PDF.js 文档。请打开普通 PDF 页面视图，不需要 Zotero 阅读模式；如目前处于阅读模式，请先切回普通页面。",
    );
    const itemID = Number(reader?.itemID || 0);
    const attachment = itemID ? Zotero.Items.get(itemID) : null;
    if (!attachment) throw new Error("找不到当前 PDF 附件。");

    if (!confirm(reader, "将直接解析原始 PDF 的 " + handle.pdf.numPages +
      " 页，保留每页所有 Figure/表格/公式的完整画面并附加可搜索的英中译文页。\n" +
      "翻译文字将发送至当前选择的翻译后端（不发送页面图像）。\n" +
      "预览版原始页会栅格化为 JPEG，暂不保留矢量可编辑性。\n\n继续？")) return;

    progress(button, "正在提取 PDF.js 文本...");
    const fallback = await parseNormalPDFWithPDFJS(handle.pdf,
      ({ page, pages }) => progress(button, "解析 PDF：" + page + "/" + pages));
    let parsed = fallback;
    if (getNativePDFBackend() === "docling") {
      try {
        progress(button, "本地 Docling 正在解析页面结构...");
        parsed = await parseWithLocalDocling(await getOriginalPDFBytes(handle.pdf),
          getDoclingEndpoint(), fallback);
      } catch (error) {
        Zotero.logError(error as Error);
        if (!confirm(reader, "Docling 无法解析此 PDF：" +
          String((error as Error)?.message || error) +
          "\n是否回退到 PDF.js 内置解析？")) return;
      }
    }

    if (parsed.pages.every((page) => page.blocks.length === 0) &&
      !confirm(reader, "PDF 未提取到文字，可能是扫描版。是否仅输出原始页面画面？")) return;

    progress(button, "正在翻译 PDF.js 文本...");
    const translated = await translateNativeDocument(
      parsed, itemID, String(attachment.key || itemID),
      (done, total) => progress(button, "翻译：" + done + "/" + total),
    );
    const cutoff = parsed.pages.length - getSkipLastPages();
    const missing = parsed.pages.reduce((sum, page) =>
      sum + page.blocks.filter((block) =>
        page.index < cutoff && canTranslate(block) && !translated.has(block.id)).length, 0);
    if (missing && !confirm(reader, "有 " + missing +
      " 个段落未完成翻译。是否仅导出已完成内容和所有原始页面？")) return;

    const doc = Zotero.getMainWindow().document;
    const exportPages: NativeExportPage[] = [];
    let encodedBytes = 0;
    for (const page of parsed.pages) {
      progress(button, "保留原始页面：" + (page.index + 1) + "/" + parsed.pages.length);
      const image = await snapshotPDFPage(handle.pdf, page.index,
        doc, handle.contentWindow, 1.25);
      encodedBytes += image.length;
      if (encodedBytes > 110 * 1024 * 1024) {
        throw new Error("原始页面图像超过 110 MB；请将 PDF 拆分后分批导出。");
      }
      exportPages.push({
        pageIndex: page.index, image,
        blocks: page.blocks.filter(canTranslate).map((block) => ({
          block, translation: translated.get(block.id) || "",
        })),
      });
    }
    const title = String(attachment.getField?.("title") || "文献") + " - PDF.js 双语";
    const html = buildNativeBilingualHTML(exportPages, title, parsed.source);
    const temp = Zotero.getTempDirectory();
    temp.append("native-bilingual-" + Date.now() + "-" +
      Math.random().toString(36).slice(2, 9) + ".pdf");
    try {
      progress(button, "正在打印完整双语 PDF...");
      await printHTMLToPDF(html, temp);
      await importExportedPDF(temp, attachment, "PDF.js 原版双语");
    } finally {
      try { if (temp.exists()) temp.remove(false); } catch (_) { /* Temp only */ }
    }
    notify(reader, "PDF.js 原生导出成功。原文页面和 Figure 均以完整页面图像保存，" +
      "新增英中文本页可复制/搜索。解析方式：" + parsed.source +
      (parsed.warnings.length ? "\n提示：" + parsed.warnings.slice(0, 3).join("；") : ""));
  } catch (error) {
    Zotero.logError(error as Error);
    notify(reader, "PDF.js 导出失败：" + String((error as Error)?.message || error));
  } finally {
    active.delete(reader);
    progress(button, oldTitle);
  }
}

const CLASS_NAME = "bilingual-reader-native-pdf-button";
export function renderNativePDFToolbarButton(event: any): void {
  const { reader, doc, append } = event || {};
  if (!reader || reader.type !== "pdf" || !doc || typeof append !== "function") return;
  if (doc.querySelector("." + CLASS_NAME)) return;
  const button = doc.createElement("button") as HTMLButtonElement;
  button.type = "button";
  button.className = "toolbar-button " + CLASS_NAME;
  button.textContent = "📑";
  button.title = "PDF.js 原始 PDF 直接解析与双语导出（无需阅读模式）";
  button.setAttribute("aria-label", button.title);
  button.style.cssText = "min-width:34px;padding-inline:5px;font-size:18px;line-height:1";
  button.addEventListener("click", (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled) return;
    button.disabled = true;
    void exportNativePDFBilingual(reader, button).finally(() => {
      button.disabled = false;
    });
  });
  append(button);
}
export function cleanupNativePDFToolbarButton(reader: any): void {
  try { reader?._iframeWindow?.document?.querySelector("." + CLASS_NAME)?.remove(); }
  catch (_) { /* Viewer closed */ }
}
