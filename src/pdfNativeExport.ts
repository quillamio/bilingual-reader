/**
 * Export using native PDF parsing or an existing MinerU reading result.
 * Side-by-side embeds original PDF pages; stacked prints the parsed transcript.
 */
import { getEngine, getCacheEngineTag, getMaxCharsPerRequest, getRequestGapMs,
  getTranslationPageCount, getTranslateAllPages, getMaxConsecutiveErrors, type PDFExportLayout } from "./settings";
import { loadCachedTranslation, saveCachedTranslation } from "./translationCache";
import { buildBatchPayload, packBatchItems, parseBatchResult, splitTextForRequest,
  type BatchInput } from "./translationPipeline";
import { translateText } from "./bilingualReader";
import { printHTMLToPDF, importExportedPDF } from "./readerUI";
import { getNativePDFBackend, getDoclingEndpoint, parseWithLocalDocling } from "./pdfNativeDocling";
import { getNormalPDFProxy, getPDFPageLayout, parseNormalPDFWithPDFJS, renderPDFRegion } from "./pdfNativeRuntime";
import { isCloudParser, CLOUD_NAMES } from "./pdfCloudModel";
import { parseWithCloudProvider } from "./pdfCloudParsers";
import { composeSideBySidePDF, readOriginalAttachment, readPDFFile, writePDFFile } from "./pdfVectorExport";
import { isManagedService, getServiceDefinition, assertServiceConfigured } from "./serviceCatalog";
import { describePDFParser, PDF_PARSER_NAMES, type NativeDocument, type NativeBlock } from "./pdfNativeModel";
import { buildNativeBilingualHTML, buildTranslatedPageHTML, type NativeExportPage } from "./pdfNativeHtml";
import { buildInPlacePageHTML, type PositionedPDFPage } from "./pdfInPlaceLayout";
import { isBodyText, joinPDFLines, normalizedSource, uncoveredBlocks } from "./pdfCoverage";
import type { MinerUReadingResult } from "./pdfNativeReadingPanel";

const active = new WeakSet<object>();
const isFailure = (value: string) => !value.trim() ||
  /^\[请求错误\]|HTTP\s+\d{3}|此翻译服务不可用/iu.test(value.trim());
const isUntranslated = (source: string, result: string): boolean =>
  isFailure(result) || ((source.match(/[A-Za-z]{2,}/gu)?.length || 0) >= 5 &&
    normalizedSource(source) === normalizedSource(result));
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
    if (isUntranslated(chunk, response.text)) throw new Error("翻译服务返回空白、错误或与原文相同的内容。");
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
      const text = block.source === "pdfjs" && block.lineTexts?.length
        ? joinPDFLines(block.lineTexts) : block.text;
      const cached = loadCachedTranslation(itemKey, text, engineTag, result => isUntranslated(text, result));
      if (cached) translated.set(block.id, cached);
      else pending.push({ ...block, text });
    }
  }
  const jobs = packBatchItems(pending, getMaxCharsPerRequest(), isManagedService(engine) ? 1 : 4);
  let done = 0;
  let consecutiveFailures = 0;
  for (const job of jobs) {
    if (isCancelled?.()) throw new Error("PDF.js 翻译任务已取消。");
    let batchResults: string[] | null = null;
    let batchTag = engineTag;
    if (job.length > 1) {
      try {
        const batch = await translateSegment(buildBatchPayload(job), itemID, engine);
        batchResults = parseBatchResult(batch.text, job.length);
        batchTag = batch.tag;
      } catch (error) {
        Zotero.logError(error as Error);
      }
    }
    for (const [index, block] of job.entries()) {
      if (isCancelled?.()) throw new Error("PDF.js 翻译任务已取消。");
      try {
        const fromBatch = batchResults?.[index];
        const { text: result, tag } = fromBatch && !isUntranslated(block.text, fromBatch)
          ? { text: fromBatch, tag: batchTag }
          : await translateSegment(block.text, itemID, engine);
        translated.set(block.id, result);
        saveCachedTranslation(itemKey, block.text, result, engine === "pdftranslate" ? tag : engineTag, isFailure);
        consecutiveFailures = 0;
      } catch (error) {
        Zotero.logError(error as Error);
        consecutiveFailures++;
        if (consecutiveFailures >= getMaxConsecutiveErrors()) {
          throw new Error("连续翻译失败，停止生成不完整文件：" +
            String((error as Error)?.message || error));
        }
      }
    }
    done += job.length;
    if (isCancelled?.()) throw new Error("PDF.js 翻译任务已取消。");
    onProgress?.(done, pending.length);
    if (getRequestGapMs()) await Zotero.Promise.delay(getRequestGapMs());
  }
  return translated;
}

/** Use each physical text block as the unit of translation and placement. */
export async function supplementReadingPDFPages(
  reader: any, attachment: Zotero.Item, pages: PositionedPDFPage[], button: HTMLButtonElement | null,
): Promise<{ pages: PositionedPDFPage[]; missing: string }> {
  const handle = getNormalPDFProxy(reader);
  if (!handle) throw new Error("未取得原始 PDF，无法检查左右对照的正文覆盖。");

  const physical = await parseNormalPDFWithPDFJS(handle,
    ({ page, pages: total }) => progress(button, `检查 PDF 翻译覆盖：${page}/${total}`), undefined, true);
  const cutoff = getTranslationPageCount(physical.pages.length);
  const allPages = getTranslateAllPages();
  const reuse = new Map<string, string>();
  for (const page of pages) {
    for (const paragraph of page.paragraphs) {
      const source = normalizedSource(paragraph.sourceText);
      if (source && !isUntranslated(source, paragraph.text)) reuse.set(source, paragraph.text);
    }
  }
  const reused = new Map<string, string>();
  const targets = physical.pages.map(source => {
    const reading = pages[source.index];
    const blocks: NativeBlock[] = [];
    if (source.index >= cutoff) return { ...source, blocks };
    for (const block of source.blocks) {
      if (!block.lineRects?.length ||
          (block.type !== "heading" && block.type !== "caption" && !isBodyText(block, source.width)) ||
          (!allPages && /^(references|bibliography|参考文献)$/iu.test(block.text.trim()))) continue;
      const fragments = allPages ? [block] : uncoveredBlocks(block, reading?.excludedRects || []);
      for (const fragment of fragments) {
        const text = fragment.lineTexts ? joinPDFLines(fragment.lineTexts) : normalizedSource(fragment.text);
        const translation = reuse.get(text) || reuse.get(normalizedSource(fragment.text));
        if (translation) reused.set(fragment.id, translation);
        blocks.push(fragment);
      }
    }
    return { ...source, blocks };
  });
  const translated = await translateNativeDocument({
    ...physical, pages: targets.map(page => ({ ...page, blocks: page.blocks.filter(block => !reused.has(block.id)) })),
  }, attachment.id, String(attachment.key || attachment.id),
  (done, total) => progress(button, `补译遗漏段落：${done}/${total}`));

  let missingCount = 0;
  const missingPages: number[] = [];
  const fullyPositioned = targets.map(page => {
    const existing = pages[page.index];
    if (!page.blocks.length) return {
      pageIndex: page.index, paragraphs: page.index < cutoff ? existing?.paragraphs || [] : [],
    };
    const before = missingCount;
    const paragraphs = page.blocks.flatMap(block => {
      const text = reused.get(block.id) || translated.get(block.id);
      if (!text) {
        missingCount++;
        return [];
      }
      return [{ text, heading: block.type === "heading", rects: block.lineRects! }];
    });
    if (missingCount > before) missingPages.push(page.index + 1);
    return { pageIndex: page.index, paragraphs };
  });
  return {
    pages: fullyPositioned,
    missing: missingCount
      ? `第 ${missingPages.join("、")} 页共有 ${missingCount} 个文字块未完成翻译，右侧会保留这些块的原文。`
      : "",
  };
}

/** Keep the original on the left and print each positioned translation on the right. */
export async function saveSideBySidePDF(
  reader: any, attachment: Zotero.Item, pages: PositionedPDFPage[], button: HTMLButtonElement | null,
): Promise<string> {
  const stamp = Date.now() + "-" + Math.random().toString(36).slice(2);
  const temp = Zotero.getTempDirectory();
  temp.append(`bilingual-right-${stamp}.pdf`);
  const combined = Zotero.getTempDirectory();
  combined.append(`bilingual-paired-${stamp}.pdf`);
  const oldTitle = button?.title || "导出双语 PDF";
  let placed = 0;
  let onContinuation = 0;
  async function print(html: string, geometry?: { width: number; height: number }) {
    try {
      await printHTMLToPDF(html, temp, geometry);
      return await readPDFFile(temp);
    } finally {
      if (temp.exists()) temp.remove(false);
    }
  }
  async function* transcripts() {
    for (const page of pages) {
      progress(button, "左右对照排版：" + (page.pageIndex + 1) + "/" + pages.length);
      if (!page.paragraphs.length) {
        yield { pageIndex: page.pageIndex };
        continue;
      }
      let bytes: Uint8Array | undefined;
      let remaining = page.paragraphs;
      if (page.paragraphs.some(paragraph => paragraph.rects.length)) {
        try {
          const geometry = await getPDFPageLayout(reader, page.pageIndex);
          const png = await renderPDFRegion(reader, page.pageIndex, geometry.box);
          if (png) {
            const prepared = await buildInPlacePageHTML(
              Zotero.getMainWindow().document, png, geometry, page.paragraphs,
            );
            if (prepared.placed) {
              bytes = await print(prepared.html, geometry);
              placed += prepared.placed;
              remaining = prepared.remaining;
            }
          }
        } catch (error) {
          Zotero.logError(error as Error);
        }
      }
      const continuation = remaining.length
        ? await print(buildTranslatedPageHTML({ ...page, paragraphs: remaining, continuation: true }))
        : undefined;
      onContinuation += remaining.length;
      yield { pageIndex: page.pageIndex, bytes, continuation };
    }
  }
  try {
    const original = await readOriginalAttachment(attachment);
    const paired = await composeSideBySidePDF(original, transcripts(), pages.length);
    if (!placed && !onContinuation) throw new Error("没有可导出的译文。");
    await writePDFFile(combined, paired);
    await importExportedPDF(combined, attachment, "左右对照翻译");
    return onContinuation ? `\n${onContinuation} 段无法安全放回原位，已加入对应原页的译文续页。` : "";
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
    const sideBySide = layout === "side-by-side";
    const handle = !fallbackReading || sideBySide ? getNormalPDFProxy(reader) : null;
    if (!handle && (!fallbackReading || sideBySide)) throw new Error(
      "未找到 PDF.js 文档。请打开普通 PDF 页面视图，不需要 Zotero 阅读模式；如目前处于阅读模式，请先切回普通页面。",
    );
    const itemID = Number(reader?.itemID || 0);
    const attachment = itemID ? Zotero.Items.get(itemID) : null;
    if (!attachment) throw new Error("找不到当前 PDF 附件。");

    const count = fallbackReading?.document.pages.length ?? handle?.pdf.numPages;
    const message = fallbackReading
      ? "将复用已经完成的 MinerU 解析和译文。"
      : "将直接解析原始 PDF 的 " + count + " 页并翻译正文。";
    const outputDescription = sideBySide ? "左侧为原始 PDF，右侧在原文位置排入译文。"
      : "将导出按段落排列的上下对照译文。";
    if (!confirm(reader, message + "\n" + outputDescription + "\n\n继续？")) return;

    const provider = fallbackReading ? "mineru" : getNativePDFBackend();
    let parsed = fallbackReading?.document;
    let physical: NativeDocument | undefined;
    if ((!parsed || sideBySide) && handle) {
      progress(button, "正在提取 PDF.js 文本…");
      const fallback = physical = await parseNormalPDFWithPDFJS(handle,
        ({ page, pages }) => progress(button, "解析 PDF：" + page + "/" + pages), undefined, sideBySide);
      parsed ??= fallback;
      if (!fallbackReading && provider !== "pdfjs") {
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
      throw new Error(sideBySide ? "PDF 没有可定位的文字层，无法导出原位译文。"
        : "PDF 未提取到可导出的正文。");
    }

    const parserStatus = describePDFParser(parsed, provider);
    progress(button, parserStatus + " · 正在准备译文…");
    if (sideBySide && physical && parsed !== physical) {
      const geometry = physical;
      parsed = {
        ...parsed,
        pages: parsed.pages.map(page => {
          const originals = geometry.pages[page.index]?.blocks || [];
          const used = new Set<NativeBlock>();
          const blocks = page.blocks.map(block => {
            if (block.source === "pdfjs") { used.add(block); return block; }
            const text = normalizedSource(block.text);
            const matches = originals.filter(candidate => normalizedSource(candidate.text) === text);
            if (matches.length !== 1) return block;
            used.add(matches[0]);
            return { ...block, lineRects: matches[0].lineRects };
          });
          // Prefer additional PDF.js text when cloud/Docling missed a region.
          // A cached MinerU session keeps its existing translations without
          // issuing new requests for unrelated text.
          if (!fallbackReading) {
            const parsedTexts = blocks.map(block => normalizedSource(block.text));
            for (const original of originals) {
              if (used.has(original) || (original.type !== "heading" && original.type !== "caption" &&
                  !isBodyText(original, page.width))) continue;
              const text = normalizedSource(original.text);
              if (parsedTexts.some(parsedText => parsedText.includes(text))) continue;
              blocks.push(original);
            }
          }
          return { ...page, blocks };
        }),
      };
    }
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
      const note = await saveSideBySidePDF(reader, attachment, parsed.pages.map(page => ({
        pageIndex: page.index,
        paragraphs: page.blocks.flatMap(block => {
          const text = translated.get(block.id);
          return text ? [{ text, heading: block.type === "heading", rects: block.lineRects || [] }] : [];
        }),
      })), button);
      notify(reader, "左右对照导出成功。左侧为原始 PDF，右侧为原位译文。" + note + "\n" + parserStatus +
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
