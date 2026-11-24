/**
 * Export using native PDF parsing or an existing MinerU reading result.
 * Side-by-side embeds original PDF pages; stacked prints the parsed transcript.
 */
import { getEngine, getCacheEngineTag, getMaxCharsPerRequest, getRequestGapMs,
  getTranslationPageCount, getMaxConsecutiveErrors, type PDFExportLayout } from "./settings";
import { loadCachedTranslation, saveCachedTranslation } from "./translationCache";
import { buildBatchPayload, packBatchItems, parseBatchResult, splitTextForRequest,
  type BatchInput } from "./translationPipeline";
import { translateText } from "./bilingualReader";
import { printHTMLToPDF, importExportedPDF } from "./readerUI";
import { getNativePDFBackend, getDoclingEndpoint, parseWithLocalDocling } from "./pdfNativeDocling";
import { getNormalPDFProxy, parseNormalPDFWithPDFJS } from "./pdfNativeRuntime";
import { isCloudParser, CLOUD_NAMES } from "./pdfCloudModel";
import { parseWithCloudProvider } from "./pdfCloudParsers";
import { composeSideBySidePDF, readOriginalAttachment, readPDFFile, writePDFFile } from "./pdfVectorExport";
import { isManagedService, getServiceDefinition, assertServiceConfigured } from "./serviceCatalog";
import { describePDFParser, PDF_PARSER_NAMES, type NativeDocument, type NativeBlock } from "./pdfNativeModel";
import { buildNativeBilingualHTML, buildTranslatedPageHTML, type NativeExportPage, type TranslatedPDFPage } from "./pdfNativeHtml";
import type { MinerUReadingResult } from "./pdfNativeReadingPanel";

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
  const promptWindow = typeof win?.confirm === "function" ? win : Zotero.getMainWindow() as any;
  return typeof promptWindow?.confirm === "function" && Boolean(promptWindow.confirm(message));
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
  const gap = getServiceDefinition(engine)?.group === "free" ? Math.max(engine === "bing" ? 300 : 750, getRequestGapMs()) : getRequestGapMs();
  const translated: string[] = [];
  let tag = getCacheEngineTag(undefined, engine);
  for (const chunk of chunks) {
    const response = await translateText(chunk, itemID, engine);
    if (isFailure(response.text)) throw new Error("翻译服务返回无效内容。");
    translated.push(response.text);
    tag = response.engineTag;
    if (gap) await Zotero.Promise.delay(gap);
  }
  return { text: translated.join(" ").trim(), tag };
}

export async function translateNativeDocument(
  document: NativeDocument,
  itemID: number,
  itemKey: string,
  onProgress?: (done: number, total: number) => void,
  isCancelled?: () => boolean,
): Promise<Map<string, string>> {
  const engine = getEngine();
  if (isManagedService(engine)) assertServiceConfigured(engine);
  const engineTag = getCacheEngineTag(undefined, engine);
  const cutoff = getTranslationPageCount(document.pages.length);
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
  const jobs = packBatchItems(pending, getMaxCharsPerRequest(), isManagedService(engine) ? 1 : 4);
  let done = 0;
  let consecutiveFailures = 0;
  for (const job of jobs) {
    if (isCancelled?.()) throw new Error("PDF.js 翻译任务已取消。");
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
        saveCachedTranslation(itemKey, block.text, result, engine === "pdftranslate" ? tag : engineTag, isFailure);
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
    if (isCancelled?.()) throw new Error("PDF.js 翻译任务已取消。");
    onProgress?.(done, pending.length);
    if (getRequestGapMs()) await Zotero.Promise.delay(getRequestGapMs());
  }
  return translated;
}

/** Print each source page's translation separately so Gecko can paginate it normally. */
export async function saveSideBySidePDF(
  attachment: Zotero.Item, pages: TranslatedPDFPage[], button: HTMLButtonElement | null,
): Promise<void> {
  const stamp = Date.now() + "-" + Math.random().toString(36).slice(2);
  const temp = Zotero.getTempDirectory();
  temp.append(`bilingual-right-${stamp}.pdf`);
  const combined = Zotero.getTempDirectory();
  combined.append(`bilingual-paired-${stamp}.pdf`);
  const oldTitle = button?.title || "导出双语 PDF";
  async function* transcripts() {
    for (const page of pages) {
      progress(button, "左右对照排版：" + (page.pageIndex + 1) + "/" + pages.length);
      try {
        await printHTMLToPDF(buildTranslatedPageHTML(page), temp);
        yield { pageIndex: page.pageIndex, bytes: await readPDFFile(temp) };
      } finally {
        if (temp.exists()) temp.remove(false);
      }
    }
  }
  try {
    const original = await readOriginalAttachment(attachment);
    const paired = await composeSideBySidePDF(original, transcripts(), pages.length);
    await writePDFFile(combined, paired);
    await importExportedPDF(combined, attachment, "左右对照翻译");
  } finally {
    try { if (combined.exists()) combined.remove(false); } catch (_) { /* Temp only */ }
    progress(button, oldTitle);
  }
}

/** Export text parsed by the selected engine while preserving original artwork. */
export async function exportNativePDFBilingual(
  reader: any, button: HTMLButtonElement | null = null, fallbackReading?: MinerUReadingResult,
  layout: PDFExportLayout = "stacked",
): Promise<void> {
  if (!reader || typeof reader !== "object" || active.has(reader)) return;
  active.add(reader);
  const oldTitle = button?.title || "导出双语 PDF";
  try {
    const handle = fallbackReading ? null : getNormalPDFProxy(reader);
    if (!handle && !fallbackReading) throw new Error(
      "未找到 PDF.js 文档。请打开普通 PDF 页面视图，不需要 Zotero 阅读模式；如目前处于阅读模式，请先切回普通页面。",
    );
    const itemID = Number(reader?.itemID || 0);
    const attachment = itemID ? Zotero.Items.get(itemID) : null;
    if (!attachment) throw new Error("找不到当前 PDF 附件。");

    const sideBySide = layout === "side-by-side";
    const count = fallbackReading?.document.pages.length ?? handle?.pdf.numPages;
    const message = fallbackReading
      ? "将复用已经完成的 MinerU 解析和译文。"
      : "将直接解析原始 PDF 的 " + count + " 页并翻译正文。";
    const outputDescription = sideBySide ? "左侧保留原始 PDF 页面，右侧放该页译文。"
      : "将导出按段落排列的上下对照译文。";
    if (!confirm(reader, message + "\n" + outputDescription + "\n\n继续？")) return;

    const provider = fallbackReading ? "mineru" : getNativePDFBackend();
    let parsed = fallbackReading?.document;
    if (!parsed && handle) {
      progress(button, "正在提取 PDF.js 文本…");
      const fallback = await parseNormalPDFWithPDFJS(handle,
        ({ page, pages }) => progress(button, "解析 PDF：" + page + "/" + pages));
      parsed = fallback;
      if (provider !== "pdfjs") {
        if (isCloudParser(provider) && !confirm(reader,
          "即将把完整原始 PDF 上传到 " + CLOUD_NAMES[provider] + "。\n\n同意上传？")) return;
        try {
          progress(button, "正在解析：" + PDF_PARSER_NAMES[provider]);
          const bytes = await readOriginalAttachment(attachment);
          parsed = provider === "docling"
            ? await parseWithLocalDocling(bytes, getDoclingEndpoint(), fallback)
            : await parseWithCloudProvider(provider, bytes, fallback);
        } catch (error) {
          if (!confirm(reader, "所选解析服务失败：" +
            (error as Error).message + "\n是否回退到 PDF.js 内置解析？")) return;
        }
      }
    }
    if (!parsed) throw new Error("未取得可导出的解析结果。");
    if (parsed.pages.every((page) => page.blocks.length === 0)) {
      if (!sideBySide) throw new Error("PDF 未提取到可导出的正文。");
      if (!confirm(reader, "PDF 未提取到文字，可能是扫描版。是否仅输出原始页面？")) return;
    }

    const parserStatus = describePDFParser(parsed, provider);
    progress(button, parserStatus + " · 正在准备译文…");
    const translated = fallbackReading?.translations ?? await translateNativeDocument(
      parsed, itemID, String(attachment.key || itemID),
      (done, total) => progress(button, parserStatus + " · 翻译 " + done + "/" + total),
    );
    const cutoff = getTranslationPageCount(parsed.pages.length);
    const missing = parsed.pages.reduce((sum, page) =>
      sum + page.blocks.filter((block) =>
        page.index < cutoff && canTranslate(block) && !translated.has(block.id)).length, 0);
    if (missing && !confirm(reader, "有 " + missing +
      " 个段落未完成翻译。是否导出当前结果？")) return;

    if (sideBySide) {
      await saveSideBySidePDF(attachment, parsed.pages.map(page => ({
        pageIndex: page.index,
        paragraphs: page.blocks.flatMap(block => {
          const text = translated.get(block.id);
          return text ? [{ text, heading: block.type === "heading" }] : [];
        }),
        emptyMessage: page.index >= cutoff ? "已按设置跳过末尾页翻译。" : undefined,
      })), button);
      notify(reader, "左右对照导出成功。左侧为原始 PDF，右侧为译文。\n" + parserStatus +
        (parsed.warnings.length ? "\n提示：" + parsed.warnings.slice(0, 3).join("；") : ""));
      return;
    }

    const exportPages: NativeExportPage[] = parsed.pages.map(page => ({
      pageIndex: page.index,
      blocks: page.blocks.filter(canTranslate).map(block => ({
        block, translation: translated.get(block.id) || "",
      })),
    }));
    const title = String(attachment.getField?.("title") || "文献") + " - 双语对照";
    const temp = Zotero.getTempDirectory();
    temp.append("native-bilingual-" + Date.now() + "-" +
      Math.random().toString(36).slice(2, 9) + ".pdf");
    try {
      progress(button, "正在打印上下对照译文…");
      await printHTMLToPDF(buildNativeBilingualHTML(exportPages, title, parsed.source), temp);
      await importExportedPDF(temp, attachment);
    } finally {
      try { if (temp.exists()) temp.remove(false); } catch (_) { /* Temp only */ }
    }
    notify(reader, "上下对照导出成功。\n" + parserStatus +
      (parsed.warnings.length ? "\n提示：" + parsed.warnings.slice(0, 3).join("；") : ""));
  } catch (error) {
    Zotero.logError(error as Error);
    notify(reader, "双语 PDF 导出失败：" + String((error as Error)?.message || error));
  } finally {
    active.delete(reader);
    progress(button, oldTitle);
  }
}
