import { configureBilingualPDFPrintSettings, hasCompletePDFMarkers, normalizeExportContent, sanitizeExportFileBaseName, withPDFPrintDeadline } from "./pdfExportUtils";
import { freezePDFExportImages, preparePDFExportFigures } from "./pdfExportAssets";
import { getPDFExportLayout, getTranslateAllPages } from "./settings";
import { getNativePDFBackend } from "./pdfNativeDocling";
import type { PositionedPDFPage } from "./pdfInPlaceLayout";
import { PDF_DEADLINES, PDFOperationTimeoutError, withPDFOperationDeadline, writeTemporaryWithDeadline, waitForPDFExport } from "./pdfOperationDeadline";
import { PDFExportTask, PDFExportCancelledError } from "./pdfExportTask";

const TRANSLATION_CLASS = "bilingual-reader-translation";
const EXPORT_BUTTON_CLASS = "bilingual-reader-export-button";
const PRINTER_EMOJI = "🖨️";
const exportTasks = new WeakMap<object, PDFExportTask>();

function getInternalReader(reader: any): any {
  return reader?._internalReader || reader;
}

function getActiveSDTView(reader: any): any {
  const internal = getInternalReader(reader);
  if (!internal) return null;
  const primary = internal._lastViewPrimary !== false || !internal._secondaryView;
  return primary ? internal._primarySDTView : internal._secondarySDTView;
}

function getSDTDocument(reader: any): Document | null {
  try {
    const view = getActiveSDTView(reader);
    return view?._iframeDocument || view?._iframe?.contentDocument || null;
  } catch (_) {
    return null;
  }
}

function getDialogWindow(reader: any): any {
  try {
    return reader?._iframeWindow || Zotero.getMainWindow();
  } catch (_) {
    return Zotero.getMainWindow();
  }
}

function showMessage(reader: any, message: string): void {
  const win = getDialogWindow(reader);
  if (win?.alert) {
    win.alert(message);
    return;
  }
  Zotero.logError(new Error(message));
}

function confirmMessage(reader: any, message: string): boolean {
  const win = getDialogWindow(reader);
  return typeof win?.confirm === "function" && Boolean(win.confirm(message));
}

function applyEmojiButtonStyle(button: HTMLButtonElement): void {
  button.style.minWidth = "34px";
  button.style.paddingInline = "5px";
  button.style.fontSize = "19px";
  button.style.lineHeight = "1";
  button.style.fontFamily = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
}

function createToolbarEmojiButton(
  doc: Document,
  className: string,
  emoji: string,
  title: string,
  onClick: (button: HTMLButtonElement) => void,
): HTMLButtonElement {
  const button = doc.createElement("button");
  button.className = `toolbar-button ${className}`;
  button.type = "button";
  button.tabIndex = -1;
  button.textContent = emoji;
  button.title = title;
  button.setAttribute("aria-label", title);
  applyEmojiButtonStyle(button);

  button.addEventListener("click", (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick(button);
  });
  return button;
}

function escapeHTML(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getTranslationStats(doc: Document): { done: number; unfinished: number } {
  const blocks = Array.from(doc.querySelectorAll(`.${TRANSLATION_CLASS}`)) as HTMLElement[];
  let done = 0;
  let unfinished = 0;
  for (const block of blocks) {
    if (block.dataset.state === "done" && (block.textContent || "").trim()) done += 1;
    else unfinished += 1;
  }
  return { done, unfinished };
}

export function buildExportHTML(
  doc: Document, title: string, preparedRoot?: HTMLElement,
): string {
  const sourceRoot = doc.querySelector("#sdt-content") as HTMLElement | null;
  if (!sourceRoot) throw new Error("无法读取当前 Zotero 阅读模式正文。");

  const root = preparedRoot || (sourceRoot.cloneNode(true) as HTMLElement);
  // Reflow only the export clone. The live SDT reader maintains its original
  // viewport-relative geometry so highlights/annotations keep working.
  normalizeExportContent(root);
  const unfinishedBlocks = Array.from(
    root.querySelectorAll(`.${TRANSLATION_CLASS}:not([data-state="done"])`),
  ) as HTMLElement[];
  for (const block of unfinishedBlocks) block.remove();

  const removable = Array.from(
    root.querySelectorAll("script, style, link, iframe, object, embed, button, input, textarea, select"),
  ) as HTMLElement[];
  for (const element of removable) element.remove();

  for (const node of [root, ...Array.from(root.querySelectorAll("*"))] as Element[]) {
    for (const attr of Array.from(node.attributes) as Attr[]) {
      if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
    }
  }
  const safeTitle = escapeHTML(title || "中英对照翻译");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'">
<title>${safeTitle}</title>
<style>
  @page {
    size: A4;
    margin: 16mm 17mm 20mm;
  }
  html, body {
    background: #fff;
    color: #111;
    width: 100%;
    max-width: 100%;
    margin: 0;
    padding: 0;
    box-sizing: border-box;
    height: auto;
    min-height: 0;
    max-height: none;
    overflow: visible;
  }
  body {
    overflow-wrap: anywhere;
    font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial,
      "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-size: 10.5pt;
    line-height: 1.55;
  }
  /* The printable width is governed by @page margins, not Zotero's
     on-screen SDT viewport. All exported text must reflow inside it. */
  #sdt-content {
    position: static !important;
    transform: none !important;
    width: 100% !important;
    min-width: 0 !important;
    max-width: 100% !important;
    box-sizing: border-box !important;
    margin: 0 !important;
    padding: 0 !important;
    height: auto !important;
    max-height: none !important;
    overflow: visible !important;
    contain: none !important;
    content-visibility: visible !important;
  }
  #sdt-content :is(
    p, h1, h2, h3, h4, h5, h6, div, section, article,
    li, ul, ol, blockquote, aside, figcaption
  ):not(figure *) {
    position: static !important;
    transform: none !important;
    translate: none !important;
    float: none !important;
    left: auto !important;
    right: auto !important;
    width: auto !important;
    min-width: 0 !important;
    max-width: 100% !important;
    box-sizing: border-box !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
    overflow-wrap: anywhere !important;
    height: auto !important;
    min-height: 0 !important;
    max-height: none !important;
    overflow: visible !important;
    contain: none !important;
    content-visibility: visible !important;
    clip: auto !important;
    clip-path: none !important;
  }
  #sdt-content :is(p, li, blockquote, aside, figcaption) {
    text-indent: 0 !important;
    white-space: normal !important;
  }
  #sdt-content :is(ul, ol) {
    padding-inline-start: 1.25em !important;
  }
  /* Keep long bilingual paragraphs flowing across page boundaries. */
  p, li, blockquote, .${TRANSLATION_CLASS} {
    break-inside: auto !important;
    page-break-inside: auto !important;
    orphans: 2;
    widows: 2;
  }
  h1, h2, h3, h4, h5, h6 {
    break-after: avoid-page;
    page-break-after: avoid;
    line-height: 1.3;
  }
  /* Prevent blank bands caused by pushing whole figures/tables/pre
     blocks to the next sheet. Individual table rows remain together. */
  figure, table, pre {
    break-inside: auto !important;
    page-break-inside: auto !important;
  }
  tr { break-inside: avoid-page; page-break-inside: avoid; }
  pre { white-space: pre-wrap !important; overflow-wrap: anywhere !important; }
  img, svg, canvas {
    max-width: 100% !important;
    height: auto !important;
    object-fit: contain;
  }
  figure { margin: 8pt 0; max-width: 100%; overflow: visible; }
  figure img, figure svg, figure canvas { max-height: 225mm !important; }
  .sdt-source-crop-page { max-width: 100%; aspect-ratio: auto !important; }
  .sdt-source-crop-page img { display: block; }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 9pt;
  }
  th, td {
    border: 0.5pt solid #bbb;
    padding: 3pt 4pt;
    vertical-align: top;
  }
  a {
    color: inherit;
    text-decoration: none;
  }
  .${TRANSLATION_CLASS} {
    white-space: pre-wrap !important;
    overflow-wrap: anywhere !important;
    margin: 0.18em 0 0.7em !important;
    padding: 0.12em 0 0.12em 0.78em !important;
    border-left: 2.2pt solid #c7354a !important;
    color: #222 !important;
    background: transparent !important;
    font-size: 10.2pt !important;
    line-height: 1.58 !important;
    break-inside: auto !important;
    page-break-inside: auto !important;
    orphans: 2;
    widows: 2;
  }
  .${TRANSLATION_CLASS}[data-state="done"]::before {
    content: "";
  }
</style>
</head>
<body>
${root.outerHTML}
</body>
</html>`;
}

async function readPDFMarkers(file: any): Promise<{ header: string; tail: string }> {
  const header = await (Zotero.File as any).getBinaryContentsAsync(file.path, 8);
  const bytesToRead = Math.min(file.fileSize, 4096);
  // Zotero 10 exposes the Firefox/XPCOM file-stream interfaces. Do not rely
  // on OS.File or IOUtils being visible in the add-on's global scope.
  const components = (globalThis as any).Components;
  if (!components?.classes || !components?.interfaces) {
    throw new Error("当前 Zotero 无法访问 PDF 文件读取接口。");
  }
  const stream = components.classes["@mozilla.org/network/file-input-stream;1"].createInstance(
    components.interfaces.nsIFileInputStream,
  );
  stream.init(file, 0x01, 0, 0);
  try {
    stream
      .QueryInterface(components.interfaces.nsISeekableStream)
      .seek(components.interfaces.nsISeekableStream.NS_SEEK_END, -bytesToRead);
    const binary = components.classes["@mozilla.org/binaryinputstream;1"].createInstance(
      components.interfaces.nsIBinaryInputStream,
    );
    binary.setInputStream(stream);
    return { header, tail: binary.readBytes(bytesToRead) };
  } finally {
    stream.close();
  }
}

async function waitForGeneratedFile(file: any, task?: PDFExportTask): Promise<void> {
  let previousSize = 0;
  let stableObservations = 0;
  let sawOutput = false;

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    task?.throwIfCancelled();
    try {
      if (file.exists() && file.fileSize >= 32) {
        sawOutput = true;
        const currentSize = file.fileSize;
        stableObservations = currentSize === previousSize ? stableObservations + 1 : 0;
        previousSize = currentSize;

        // Size alone does not prove the PDF has finished being written.
        if (stableObservations >= 2) {
          const { header, tail } = await withPDFOperationDeadline("打印文件完整性检查",
            Math.min(PDF_DEADLINES.fileMarkers, Math.max(1, deadline - Date.now())), () => readPDFMarkers(file), undefined, task);
          if (hasCompletePDFMarkers(header, tail)) return;
        }
      }
    } catch (error) {
      if (error instanceof PDFOperationTimeoutError || error instanceof PDFExportCancelledError) throw error;
      // Printing may still be creating or flushing the file.
    }
    await waitForPDFExport(100, task);
  }
  throw new Error(
    sawOutput
      ? "PDF 文件头或结束标记无效，或打印任务未完成；已取消导入，避免保存损坏附件。"
      : "PDF 打印任务已结束，但未检测到输出文件。",
  );
}

export async function importExportedPDF(tempFile: any, sourceAttachment: any, suffix = "中英对照翻译", task?: PDFExportTask): Promise<any> {
  const parentItemID = Number(sourceAttachment?.parentItemID || 0);
  if (!parentItemID) {
    throw new Error("当前 PDF 没有父级文献条目，无法作为条目附件保存。请先为该 PDF 创建父级条目。");
  }

  const parentItem = Zotero.Items.get(parentItemID);
  const parentTitle = String(parentItem?.getField?.("title") || "中英对照翻译").trim();
  task?.beginImport();
  const attachment = await (Zotero.Attachments as any).importFromFile({
    file: tempFile,
    parentItemID,
    fileBaseName: sanitizeExportFileBaseName(`${parentTitle || "文献"} - ${suffix}`),
    contentType: "application/pdf",
  });
  attachment.setField("title", `${parentTitle || "文献"} - ${suffix}`);
  await attachment.saveTx();
  return attachment;
}

function getHiddenBrowserConstructor(): any {
  const chromeUtils = (globalThis as any).ChromeUtils;
  if (!chromeUtils?.importESModule) {
    throw new Error("当前 Zotero 无法加载隐藏打印浏览器模块。");
  }
  const module = chromeUtils.importESModule("chrome://zotero/content/HiddenBrowser.mjs");
  if (!module?.HiddenBrowser) {
    throw new Error("当前 Zotero 未提供 HiddenBrowser 打印模块。");
  }
  return module.HiddenBrowser;
}

export async function printHTMLToPDF(
  html: string, tempFile: any, size?: { width: number; height: number }, task?: PDFExportTask,
): Promise<void> {
  task?.throwIfCancelled();
  const mainWindow = Zotero.getMainWindow() as any;
  const printUtils = mainWindow?.PrintUtils;
  if (!printUtils?.getPrintSettings) {
    throw new Error("无法取得 Zotero 的 PDF 打印设置。");
  }

  const HiddenBrowser = getHiddenBrowserConstructor();
  const browser = new HiddenBrowser({ useHiddenFrame: false });
  const htmlFile = Zotero.getTempDirectory();
  htmlFile.append("br-print-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".html");

  try {
    // A local temporary file avoids huge encoded data URLs and logging PDF
    // contents in the browser's load diagnostic.
    await writeTemporaryWithDeadline("打印 HTML 临时文件写入", PDF_DEADLINES.fileWrite,
      () => (Zotero.File as any).putContentsAsync(htmlFile.path, html),
      () => { if (htmlFile.exists()) htmlFile.remove(false); }, task);
    const loaded = await withPDFOperationDeadline("隐藏浏览器加载", PDF_DEADLINES.browserLoad,
      () => browser.load(htmlFile.path), undefined, task);
    if (!loaded) throw new Error("用于导出的中英对照页面加载失败。");

    // 'interactive' is too early: lazy images may still be loading.
    // Never silently print if the ready-state actor failed.
    await withPDFOperationDeadline("打印页面资源加载", PDF_DEADLINES.browserReady,
      () => browser.waitForDocument({ allowInteractiveAfter: false }), undefined, task);

    const browsingContext = browser.browsingContext;
    if (!browsingContext?.print) {
      throw new Error("Zotero 隐藏打印浏览器没有可用的 PDF 打印上下文。");
    }

    const settings = printUtils.getPrintSettings("", false);
    // nsIPrintSettings no longer exposes a `printToFile` property. Assigning
    // that obsolete expando on an XPCOM WrappedNative throws on Zotero 10.
    // outputDestination=1 is the supported way to select file output.
    settings.outputDestination = 1;
    settings.outputFormat = 2;
    settings.toFileName = tempFile.path;
    settings.printSilent = true;
    settings.printInColor = true;
    settings.printBGColors = true;
    settings.printBGImages = true;
    // CSS @page sets the A4 margins. Reset prior printer offsets so the
    // entire text column is rendered inside the page instead of at x < 0.
    configureBilingualPDFPrintSettings(settings, size);
    settings.headerStrLeft = "";
    settings.headerStrCenter = "";
    settings.headerStrRight = "";
    settings.footerStrLeft = "";
    settings.footerStrCenter = "";
    settings.footerStrRight = "";

    // A hung Gecko print must reach finally so the hidden browser is destroyed.
    // Allow longer for a whole-document reflow than for a positioned page.
    await withPDFPrintDeadline(() => browsingContext.print(settings), size ? 120000 : 300000, task,
      () => { if (tempFile.exists()) tempFile.remove(false); });
    await waitForGeneratedFile(tempFile, task);
  } finally {
    try {
      browser.destroy();
    } catch (_) {
      // Best-effort cleanup only.
    }
    try { if (htmlFile.exists()) htmlFile.remove(false); } catch (_) { /* Temp only */ }
  }
}

function blockIsHeading(source: Element | null): boolean {
  const text = source?.textContent?.trim();
  if (!source || !text || text.length > 145 || /[.!?]$/u.test(text)) return false;
  const bold = Array.from(source.querySelectorAll("b,strong")) as Element[];
  return bold.some(element => element.textContent?.trim() === text);
}

function getSDTAnchors(structure: any, path: string): number[][] {
  if (!/^\d+(?:\.\d+)*$/u.test(path)) return [];
  let block = structure;
  for (const part of path.split(".")) block = block?.content?.[Number(part)];
  return (Array.from(block?.anchor?.pageRects || []) as number[][])
    .filter(anchor => anchor.length === 5 && anchor.every(Number.isFinite));
}

/** Read already-translated SDT paragraphs only when their physical page mapping is available. */
function getReadingTranslationPages(reader: any, doc: Document): PositionedPDFPage[] | null {
  let structure: any;
  try {
    const view = getActiveSDTView(reader);
    structure = view?.getData?.()?.structure || view?._structure;
  } catch (_) {
    return null;
  }
  const pageCount = structure?.catalog?.pages?.length;
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) return null;
  const pages = Array.from({ length: pageCount }, (_, pageIndex): PositionedPDFPage => ({
    pageIndex, paragraphs: [],
  }));
  if (!getTranslateAllPages()) {
    for (const element of doc.querySelectorAll<HTMLElement>("#sdt-content .sdt-reference[data-ref-path]")) {
      for (const [pageIndex, left, bottom, right, top] of getSDTAnchors(structure, element.dataset.refPath || "")) {
        const page = pages[pageIndex];
        if (page) (page.excludedRects ||= []).push({ left, bottom, right, top });
      }
    }
  }
  for (const target of doc.querySelectorAll<HTMLElement>(`#sdt-content .${TRANSLATION_CLASS}[data-state="done"]`)) {
    const text = target.textContent?.trim();
    if (!text) continue;
    const source = target.previousElementSibling;
    const heading = source?.matches("h1,h2,h3,h4,h5,h6") || blockIsHeading(source);
    const anchors = getSDTAnchors(structure, target.dataset.sourceRefPath || "");
    const page = pages[Number(target.dataset.sourcePage) - 1] || pages[anchors[0]?.[0]];
    if (!page) continue;
    // A translation spanning pages cannot be split reliably by character count.
    const rects = anchors.every(anchor => anchor[0] === page.pageIndex)
      ? anchors.map(([, left, bottom, right, top]) => ({ left, bottom, right, top }))
      : [];
    page.paragraphs.push({ text, sourceText: source?.textContent?.trim(), heading, rects });
  }
  return pages;
}

export async function exportBilingualPDF(reader: any, button: HTMLButtonElement | null = null, task?: PDFExportTask): Promise<void> {
  task?.throwIfCancelled();
  const { hasMinerUReadingFallback, getMinerUReadingResult } = await import("./pdfNativeReadingPanel");
  task?.throwIfCancelled();
  const fallback = getMinerUReadingResult(reader);
  const layout = getPDFExportLayout();
  if (hasMinerUReadingFallback(reader) && !fallback) {
    showMessage(reader, "MinerU 双语阅读尚无可导出的译文。请等到翻译完成。");
    return;
  }
  const doc = getSDTDocument(reader);
  const pages = layout === "side-by-side" && doc && getNativePDFBackend() === "pdfjs"
    ? getReadingTranslationPages(reader, doc) : null;
  if (fallback || (layout === "side-by-side" && !pages)) {
    const { exportNativePDFBilingual } = await import("./pdfNativeExport");
    await exportNativePDFBilingual(reader, button, fallback, layout, task);
    return;
  }

  if (!doc?.querySelector("#sdt-content")) {
    showMessage(reader, "请先在 Zotero 阅读模式中开启中英对照，再导出 PDF。");
    return;
  }

  const { done, unfinished } = getTranslationStats(doc);
  if (!pages && !done) {
    showMessage(reader, "当前没有已成功完成的译文，暂时无法导出中英对照 PDF。");
    return;
  }

  if (
    !pages && unfinished > 0 &&
    !confirmMessage(
      reader,
      `当前已有 ${done} 段译文完成，仍有 ${unfinished} 段未成功完成。\n\n是否只导出已经成功的中英对照内容？`,
    )
  ) {
    return;
  }

  if (
    !confirmMessage(
      reader,
      (pages ? "左侧保留原始 PDF，右侧在原文位置排入译文，并用当前引擎补译漏段。无法原位放入的译文会加在续页。"
        : "将生成一个新的上下对照 PDF。") + "\n导出后将作为附件加入这篇文献。\n\n继续导出？",
    )
  ) {
    return;
  }

  const itemID = Number(reader?.itemID || 0);
  const sourceAttachment = itemID ? Zotero.Items.get(itemID) : null;
  if (!sourceAttachment) {
    showMessage(reader, "无法取得当前 PDF 的 Zotero 附件条目。");
    return;
  }

  const parentItemID = Number((sourceAttachment as any).parentItemID || 0);
  const parentItem = parentItemID ? Zotero.Items.get(parentItemID) : null;
  const parentTitle = String(
    parentItem?.getField?.("title") || sourceAttachment.getField?.("title") || "文献",
  );
  if (pages) {
    try {
      const { supplementReadingPDFPages, saveSideBySidePDF } = await import("./pdfNativeExport");
      const result = await supplementReadingPDFPages(reader, sourceAttachment, pages, button, task);
      if (result.missing && !confirmMessage(reader, result.missing + "\n\n是否生成明确标记为「部分译文」的 PDF？")) return;
      const note = await saveSideBySidePDF(reader, sourceAttachment, result.pages, button, task, Boolean(result.missing));
      showMessage(reader, (result.missing ? "已导出部分译文。" : "左右对照导出成功。") + "左侧为原始 PDF，右侧为原位译文。" +
        (result.missing ? "\n" + result.missing : "") + note);
    } catch (error) {
      if (error instanceof PDFExportCancelledError || task?.cancelled) return;
      Zotero.logError(error as Error);
      showMessage(reader, `左右对照导出失败：${(error as Error)?.message || String(error)}`);
    }
    return;
  }

  const tempFile = Zotero.getTempDirectory();
  // A stable .pdf suffix must not depend on the length of the article title.
  tempFile.append(`bilingual-reader-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.pdf`);

  try {
    if (tempFile.exists()) tempFile.remove(false);
  } catch (_) {
    // A timestamped file should normally not exist.
  }

  try {
    const liveRoot = doc.querySelector("#sdt-content") as HTMLElement;
    await preparePDFExportFigures(getActiveSDTView(reader), liveRoot, reader, task);
    const exportClone = liveRoot.cloneNode(true) as HTMLElement;
    const assets = await freezePDFExportImages(liveRoot, exportClone, task);
    task?.throwIfCancelled();
    if ((assets.failed || assets.absentFigureCaptions) && !confirmMessage(reader,
      `有 ${assets.failed} 个图像资源无法嵌入，${assets.absentFigureCaptions} 个图注未找到对应图片。是否继续导出已读取的内容？`)) return;

    const html = buildExportHTML(doc, `${parentTitle} - 中英对照翻译`, exportClone);
    await printHTMLToPDF(html, tempFile, undefined, task);
    await importExportedPDF(tempFile, sourceAttachment, unfinished > 0 ? "中英对照翻译（部分译文）" : undefined, task);
  } catch (error: any) {
    if (error instanceof PDFExportCancelledError || task?.cancelled) return;
    Zotero.logError(error as Error);
    showMessage(reader, `导出中英对照 PDF 失败：${error?.message || String(error)}`);
    return;
  } finally {
    try {
      if (tempFile.exists()) tempFile.remove(false);
    } catch (_) {
      // The imported Zotero attachment has already copied the file.
    }
  }

  showMessage(reader, unfinished > 0 ? "已生成部分译文 PDF。未完成段落可点击 🔄 补译后重新导出。" : "已生成中英对照 PDF，并保存到当前文献的 Zotero 附件中。");
}

export function renderReaderExportButton(event: any): void {
  const { reader, doc, append } = event || {};
  if (!reader || reader.type !== "pdf" || !doc || typeof append !== "function") return;

  if (!doc.querySelector(`.${EXPORT_BUTTON_CLASS}`)) {
    append(
      createToolbarEmojiButton(
        doc,
        EXPORT_BUTTON_CLASS,
        PRINTER_EMOJI,
        "将当前中英对照结果导出为 PDF 并添加到文献附件",
        (button) => {
          const existing = exportTasks.get(reader);
          if (existing) {
            if (existing.canCancel) {
              existing.cancel();
              button.disabled = true;
              button.title = "正在停止导出并清理临时文件…";
              button.setAttribute("aria-label", button.title);
            }
            return;
          }
          const oldTitle = button.title;
          const task = new PDFExportTask(() => {
            button.disabled = true;
            button.title = "正在保存 Zotero 附件，此阶段不可取消…";
            button.setAttribute("aria-label", button.title);
          });
          exportTasks.set(reader, task);
          button.textContent = "⏹️";
          button.title = "正在导出，点击停止";
          button.setAttribute("aria-label", button.title);
          void exportBilingualPDF(reader, button, task).catch(error => {
            if (!task.cancelled && !(error instanceof PDFExportCancelledError)) {
              Zotero.logError(error as Error);
              showMessage(reader, String((error as Error).message || error));
            }
          }).finally(() => {
            exportTasks.delete(reader);
            try {
              button.textContent = PRINTER_EMOJI;
              button.title = oldTitle;
              button.setAttribute("aria-label", oldTitle);
              button.disabled = false;
            } catch (_) { /* Reader may have closed during export. */ }
          });
        },
      ),
    );
  }
}

export function cleanupReaderUI(reader: any): void {
  if (reader && typeof reader === "object") exportTasks.get(reader)?.cancel();
  let doc: Document | null = null;
  try {
    doc = reader?._iframeWindow?.document || null;
  } catch (_) {
    doc = null;
  }
  doc?.querySelector(`.${EXPORT_BUTTON_CLASS}`)?.remove();
}
