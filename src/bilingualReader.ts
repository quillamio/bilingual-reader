const PLUGIN_ID = "bilingual-reader@zotero.local";
const BASE = "extensions.zotero.bilingualreader";
const TARGET_LANG = "zh-CN";
const TRANSLATION_CLASS = "bilingual-reader-translation";
const TOOLBAR_BUTTON_CLASS = "bilingual-reader-toolbar-button";
const STYLE_ID = "bilingual-reader-style";

interface ReaderParagraph {
  element: HTMLElement;
  refPath: string;
  sourceText: string;
  translation?: string;
}

function hash(text: string): string {
  let result = 2166136261;
  for (let i = 0; i < text.length; i++) {
    result = Math.imul(result ^ text.charCodeAt(i), 16777619);
  }
  return (result >>> 0).toString(16);
}

function cacheKey(itemKey: string, sourceText: string): string {
  return `${BASE}.cache.${itemKey}.${hash(sourceText)}.${TARGET_LANG}`;
}

function loadCached(itemKey: string, sourceText: string): string | undefined {
  const value = (Zotero.Prefs as any).get(cacheKey(itemKey, sourceText));
  return typeof value === "string" && value ? value : undefined;
}

function saveCached(itemKey: string, sourceText: string, translation: string): void {
  (Zotero.Prefs as any).set(cacheKey(itemKey, sourceText), translation);
}

async function translateText(text: string, itemID: number): Promise<string> {
  const pdfTranslate = (Zotero as any).PDFTranslate;
  if (!pdfTranslate?.api?.translate) {
    throw new Error(
      "未检测到 Translate for Zotero。请先安装并启用 zotero-pdf-translate，然后在其设置中配置翻译服务。",
    );
  }

  const task = await pdfTranslate.api.translate(text, {
    pluginID: PLUGIN_ID,
    itemID,
    langto: TARGET_LANG,
  });

  if (!task?.result) {
    throw new Error("Translate for Zotero 未返回译文，请检查其翻译服务配置或网络状态。");
  }
  return String(task.result).trim();
}

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
  const view = getActiveSDTView(reader);
  return view?._iframeDocument || view?._iframe?.contentDocument || null;
}

function getDocumentRoot(doc: Document): HTMLElement | null {
  return doc.documentElement as HTMLElement | null;
}

async function ensureReadingMode(reader: any): Promise<Document> {
  let doc = getSDTDocument(reader);
  if (doc?.querySelector("#sdt-content")) return doc;

  const internal = getInternalReader(reader);
  if (!internal) {
    throw new Error("无法访问 Zotero PDF 阅读器。");
  }

  const primary = internal._lastViewPrimary !== false || !internal._secondaryView;
  if (typeof internal._setReadingMode === "function") {
    await internal._setReadingMode(primary, true);
  } else {
    throw new Error("当前 Zotero 版本未提供可用的阅读模式接口。请先手动开启“阅读模式”后重试。");
  }

  for (let i = 0; i < 150; i++) {
    doc = getSDTDocument(reader);
    if (doc?.querySelector("#sdt-content")) return doc;
    await Zotero.Promise.delay(100);
  }

  throw new Error("Zotero 阅读模式加载超时。请关闭并重新打开 PDF 后重试。");
}

function installStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;

  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .${TRANSLATION_CLASS} {
      box-sizing: border-box;
      border-left: 4px solid #c7354a;
      margin: 0.65em 0 1.25em;
      padding: 0.45em 0.95em;
      line-height: 1.75;
      font-size: 1em;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .${TRANSLATION_CLASS}[data-state="loading"] {
      opacity: 0.62;
    }
    .${TRANSLATION_CLASS}[data-state="error"] {
      opacity: 0.75;
    }
  `;

  const target = doc.head || doc.documentElement;
  target?.append(style);
}

function isTranslatableElement(element: HTMLElement): boolean {
  if (element.closest(".sdt-reference")) return false;
  if (element.closest(`.${TRANSLATION_CLASS}`)) return false;
  if (element.hidden) return false;

  const tag = element.tagName.toLowerCase();
  if (
    tag === "li" &&
    element.querySelector(
      "p[data-ref-path], h1[data-ref-path], h2[data-ref-path], h3[data-ref-path], h4[data-ref-path], h5[data-ref-path], h6[data-ref-path]",
    )
  ) {
    return false;
  }
  return true;
}

function collectParagraphs(doc: Document, itemKey: string): ReaderParagraph[] {
  const selector = [
    "#sdt-content p[data-ref-path]",
    "#sdt-content h1[data-ref-path]",
    "#sdt-content h2[data-ref-path]",
    "#sdt-content h3[data-ref-path]",
    "#sdt-content h4[data-ref-path]",
    "#sdt-content h5[data-ref-path]",
    "#sdt-content h6[data-ref-path]",
    "#sdt-content figcaption[data-ref-path]",
    "#sdt-content aside.sdt-note[data-ref-path]",
    "#sdt-content li[data-ref-path]",
  ].join(",");

  const elements = Array.from(doc.querySelectorAll(selector)) as HTMLElement[];
  const paragraphs: ReaderParagraph[] = [];

  for (const element of elements) {
    if (!isTranslatableElement(element)) continue;

    const sourceText = (element.textContent || "").replace(/\s+/g, " ").trim();
    if (sourceText.length < 2) continue;

    paragraphs.push({
      element,
      refPath: element.dataset.refPath || "",
      sourceText,
      translation: loadCached(itemKey, sourceText),
    });
  }

  return paragraphs;
}

function createTranslationBlock(doc: Document, paragraph: ReaderParagraph): HTMLDivElement {
  const block = doc.createElement("div");
  block.className = TRANSLATION_CLASS;
  block.lang = TARGET_LANG;
  block.dataset.sourceRefPath = paragraph.refPath;

  if (paragraph.translation) {
    block.dataset.state = "done";
    block.textContent = paragraph.translation;
  } else {
    block.dataset.state = "loading";
    block.textContent = "正在翻译…";
  }

  paragraph.element.after(block);
  return block;
}

function clearTranslations(doc: Document): void {
  const nodes = Array.from(doc.querySelectorAll(`.${TRANSLATION_CLASS}`)) as HTMLElement[];
  for (const node of nodes) {
    node.remove();
  }

  const root = getDocumentRoot(doc);
  if (root) delete root.dataset.bilingualReaderRunning;
}

function showError(reader: any, message: string): void {
  try {
    reader?._iframeWindow?.alert?.(message);
    return;
  } catch (_) {
    // Fall through to the Zotero main window.
  }

  try {
    Zotero.getMainWindow()?.alert(message);
  } catch (_) {
    Zotero.logError(new Error(message));
  }
}

export async function toggleBilingualReading(reader: any): Promise<void> {
  try {
    const doc = await ensureReadingMode(reader);
    const root = getDocumentRoot(doc);
    if (!root) throw new Error("无法访问 Zotero 阅读模式页面。");

    if (doc.querySelector(`.${TRANSLATION_CLASS}`)) {
      clearTranslations(doc);
      return;
    }

    if (root.dataset.bilingualReaderRunning === "true") return;
    root.dataset.bilingualReaderRunning = "true";
    installStyles(doc);

    const itemID = Number(reader?.itemID || 0);
    const item = itemID ? Zotero.Items.get(itemID) : null;
    const itemKey = String(item?.key || reader?.itemKey || itemID || "reader");
    if (!itemID) throw new Error("无法取得当前 PDF 的 Zotero 条目编号。");

    try {
      await (Zotero as any).SDT?.ensure?.(itemID, { isPriority: true });
    } catch (error) {
      Zotero.logError(error as Error);
    }

    const paragraphs = collectParagraphs(doc, itemKey);
    if (!paragraphs.length) {
      throw new Error("当前阅读模式中没有检测到可翻译的正文段落。");
    }

    const blocks = new Map<ReaderParagraph, HTMLDivElement>();
    for (const paragraph of paragraphs) {
      blocks.set(paragraph, createTranslationBlock(doc, paragraph));
    }

    for (const paragraph of paragraphs) {
      const block = blocks.get(paragraph)!;
      if (!block.isConnected) break;
      if (paragraph.translation) continue;

      try {
        const translation = await translateText(paragraph.sourceText, itemID);
        paragraph.translation = translation;
        saveCached(itemKey, paragraph.sourceText, translation);

        if (block.isConnected) {
          block.dataset.state = "done";
          block.textContent = translation;
        }
      } catch (error: any) {
        if (block.isConnected) {
          block.dataset.state = "error";
          block.textContent = `翻译失败：${error?.message || String(error)}`;
        }
      }
    }
  } catch (error: any) {
    showError(reader, error?.message || String(error));
  } finally {
    const doc = getSDTDocument(reader);
    const root = doc ? getDocumentRoot(doc) : null;
    if (root) delete root.dataset.bilingualReaderRunning;
  }
}

function renderToolbar(event: any): void {
  const { reader, doc, append } = event || {};
  if (!reader || reader.type !== "pdf" || !doc || typeof append !== "function") return;
  if (doc.querySelector(`.${TOOLBAR_BUTTON_CLASS}`)) return;

  const button = doc.createElement("button");
  button.className = `toolbar-button ${TOOLBAR_BUTTON_CLASS}`;
  button.type = "button";
  button.tabIndex = -1;
  button.textContent = "中英";
  button.title = "中英段落对照（调用 Translate for Zotero）";
  button.setAttribute("aria-label", button.title);
  button.style.minWidth = "36px";
  button.style.paddingInline = "6px";
  button.addEventListener("click", (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    void toggleBilingualReading(reader);
  });

  append(button);
}

function cleanupReader(reader: any): void {
  const sdtDoc = getSDTDocument(reader);
  if (sdtDoc) clearTranslations(sdtDoc);

  const toolbarDoc = reader?._iframeWindow?.document as Document | undefined;
  const buttons = toolbarDoc
    ? (Array.from(toolbarDoc.querySelectorAll(`.${TOOLBAR_BUTTON_CLASS}`)) as HTMLElement[])
    : [];
  for (const button of buttons) {
    button.remove();
  }
}

export function registerBilingualReader(): void {
  Zotero.Reader.registerEventListener("renderToolbar", renderToolbar, PLUGIN_ID);
}

export function unregisterBilingualReader(): void {
  Zotero.Reader.unregisterEventListener("renderToolbar", renderToolbar);

  const readers = ((Zotero.Reader as any)._readers || []) as any[];
  for (const reader of readers) {
    cleanupReader(reader);
  }
}
