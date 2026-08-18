const PLUGIN_ID = "bilingual-reader@zotero.local";
const BASE = "extensions.zotero.bilingualreader";
const TARGET_LANG = "zh-CN";
const TRANSLATION_CLASS = "bilingual-reader-translation";
const TOOLBAR_BUTTON_CLASS = "bilingual-reader-toolbar-button";
const REFRESH_BUTTON_CLASS = "bilingual-reader-refresh-button";
const SETTINGS_BUTTON_CLASS = "bilingual-reader-settings-button";
const STYLE_ID = "bilingual-reader-style";

const ENGINE_PREF = `${BASE}.engine`;
const OLLAMA_URL_PREF = `${BASE}.ollama.url`;
const OLLAMA_MODEL_PREF = `${BASE}.ollama.model`;
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_MODEL = "gpt-oss:20b";
const REQUEST_GAP_MS = 650;
const MAX_CONSECUTIVE_ERRORS = 3;

interface ReaderParagraph {
  refPath: string;
  sourceText: string;
  translation?: string;
}

interface RunState {
  generation: number;
  running: boolean;
}

const runStates = new WeakMap<object, RunState>();

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

function getStringPref(key: string, fallback: string): string {
  const value = (Zotero.Prefs as any).get(key);
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function setStringPref(key: string, value: string): void {
  (Zotero.Prefs as any).set(key, value);
}

function getEngine(): "pdftranslate" | "ollama" {
  return getStringPref(ENGINE_PREF, "pdftranslate") === "ollama" ? "ollama" : "pdftranslate";
}

async function translateWithPDFTranslate(text: string, itemID: number): Promise<string> {
  const pdfTranslate = (Zotero as any).PDFTranslate;
  if (!pdfTranslate?.api?.translate) {
    throw new Error(
      "未检测到 Translate for Zotero。请先安装并启用 zotero-pdf-translate，或在 ⚙ 中切换为 Ollama。",
    );
  }

  const task = await pdfTranslate.api.translate(text, {
    pluginID: PLUGIN_ID,
    itemID,
    langto: TARGET_LANG,
  });

  if (!task?.result) {
    throw new Error("Translate for Zotero 未返回译文，请检查翻译服务配置或网络状态。");
  }
  return String(task.result).trim();
}

async function translateWithOllama(text: string): Promise<string> {
  const baseURL = getStringPref(OLLAMA_URL_PREF, DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
  const model = getStringPref(OLLAMA_MODEL_PREF, DEFAULT_OLLAMA_MODEL);
  const url = `${baseURL}/api/chat`;

  const body = {
    model,
    stream: false,
    keep_alive: "30m",
    messages: [
      {
        role: "system",
        content:
          "你是专业的生物医学论文翻译助手。把用户提供的英文准确翻译为简体中文。保留基因、蛋白、药物、统计学符号、数字、单位、图表编号和文献引用；不要总结，不要解释，不要添加前言，只输出译文。",
      },
      {
        role: "user",
        content: text,
      },
    ],
    options: {
      temperature: 0.1,
    },
  };

  const xhr = await Zotero.HTTP.request("POST", url, {
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    responseType: "json",
    timeout: 180000,
  });

  if (!xhr || xhr.status < 200 || xhr.status >= 300) {
    throw new Error(`Ollama 请求失败：HTTP ${xhr?.status || "unknown"}`);
  }

  let response: any = xhr.response;
  if (typeof response === "string") {
    try {
      response = JSON.parse(response);
    } catch (_) {
      // Leave response as-is and fail with the common message below.
    }
  }

  const result = response?.message?.content;
  if (!result || typeof result !== "string") {
    throw new Error("Ollama 未返回有效译文。请确认 Ollama 已启动、模型名称正确并可正常运行。");
  }
  return result.trim();
}

async function translateText(text: string, itemID: number): Promise<string> {
  if (getEngine() === "ollama") {
    return translateWithOllama(text);
  }
  return translateWithPDFTranslate(text, itemID);
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
  try {
    const view = getActiveSDTView(reader);
    return view?._iframeDocument || view?._iframe?.contentDocument || null;
  } catch (_) {
    return null;
  }
}

function getDocumentRoot(doc: Document): HTMLElement | null {
  try {
    return doc.documentElement as HTMLElement | null;
  } catch (_) {
    return null;
  }
}

function isDeadObjectError(error: unknown): boolean {
  return /dead object|can't access dead object|cannot access dead object/i.test(String(error));
}

function nextGeneration(reader: any): number {
  const current = runStates.get(reader) || { generation: 0, running: false };
  current.generation += 1;
  current.running = true;
  runStates.set(reader, current);
  return current.generation;
}

function cancelRun(reader: any): void {
  const current = runStates.get(reader) || { generation: 0, running: false };
  current.generation += 1;
  current.running = false;
  runStates.set(reader, current);
}

function isCurrentRun(reader: any, generation: number, doc: Document): boolean {
  const state = runStates.get(reader);
  if (!state || !state.running || state.generation !== generation) return false;

  try {
    return getSDTDocument(reader) === doc && !!doc.querySelector("#sdt-content");
  } catch (_) {
    return false;
  }
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
    .${TRANSLATION_CLASS}[data-state="error"],
    .${TRANSLATION_CLASS}[data-state="paused"] {
      opacity: 0.78;
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
      refPath: element.dataset.refPath || "",
      sourceText,
      translation: loadCached(itemKey, sourceText),
    });
  }

  return paragraphs;
}

function findSourceElement(doc: Document, refPath: string): HTMLElement | null {
  try {
    const elements = Array.from(doc.querySelectorAll("#sdt-content [data-ref-path]")) as HTMLElement[];
    return elements.find((element) => element.dataset.refPath === refPath) || null;
  } catch (_) {
    return null;
  }
}

function findTranslationBlock(doc: Document, refPath: string): HTMLDivElement | null {
  try {
    const blocks = Array.from(doc.querySelectorAll(`.${TRANSLATION_CLASS}`)) as HTMLDivElement[];
    return blocks.find((block) => block.dataset.sourceRefPath === refPath) || null;
  } catch (_) {
    return null;
  }
}

function ensureTranslationBlock(doc: Document, paragraph: ReaderParagraph): HTMLDivElement | null {
  const existing = findTranslationBlock(doc, paragraph.refPath);
  if (existing) return existing;

  const source = findSourceElement(doc, paragraph.refPath);
  if (!source) return null;

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

  source.after(block);
  return block;
}

function clearTranslations(doc: Document): void {
  const nodes = Array.from(doc.querySelectorAll(`.${TRANSLATION_CLASS}`)) as HTMLElement[];
  for (const node of nodes) {
    try {
      node.remove();
    } catch (_) {
      // Reader may have replaced the SDT iframe while cleaning up.
    }
  }

  const root = getDocumentRoot(doc);
  if (root) delete root.dataset.bilingualReaderRunning;
}

function clearFailedTranslations(doc: Document): void {
  const nodes = Array.from(
    doc.querySelectorAll(
      `.${TRANSLATION_CLASS}[data-state="error"], .${TRANSLATION_CLASS}[data-state="loading"], .${TRANSLATION_CLASS}[data-state="paused"]`,
    ),
  ) as HTMLElement[];

  for (const node of nodes) {
    try {
      node.remove();
    } catch (_) {
      // Ignore stale iframe nodes.
    }
  }
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

function markRemainingPaused(doc: Document, paragraphs: ReaderParagraph[], startIndex: number): void {
  for (let i = startIndex; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i];
    if (paragraph.translation) continue;
    const block = ensureTranslationBlock(doc, paragraph);
    if (!block) continue;
    block.dataset.state = "paused";
    block.textContent = "已暂停：连续翻译失败。请切换翻译引擎或检查服务后，点击 🔄 重试。";
  }
}

async function translateParagraphs(
  reader: any,
  doc: Document,
  itemID: number,
  itemKey: string,
  paragraphs: ReaderParagraph[],
  generation: number,
): Promise<void> {
  let consecutiveErrors = 0;

  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i];
    if (!isCurrentRun(reader, generation, doc)) return;
    if (paragraph.translation) continue;

    const block = ensureTranslationBlock(doc, paragraph);
    if (!block) return;
    block.dataset.state = "loading";
    block.textContent = `正在翻译…（${getEngine() === "ollama" ? "Ollama" : "Translate for Zotero"}）`;

    try {
      const translation = await translateText(paragraph.sourceText, itemID);
      if (!isCurrentRun(reader, generation, doc)) return;

      paragraph.translation = translation;
      saveCached(itemKey, paragraph.sourceText, translation);
      consecutiveErrors = 0;

      const liveBlock = findTranslationBlock(doc, paragraph.refPath);
      if (liveBlock) {
        liveBlock.dataset.state = "done";
        liveBlock.textContent = translation;
      }
    } catch (error: any) {
      if (isDeadObjectError(error)) {
        cancelRun(reader);
        return;
      }
      if (!isCurrentRun(reader, generation, doc)) return;

      consecutiveErrors += 1;
      const liveBlock = findTranslationBlock(doc, paragraph.refPath);
      if (liveBlock) {
        liveBlock.dataset.state = "error";
        liveBlock.textContent = `翻译失败：${error?.message || String(error)}`;
      }

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        markRemainingPaused(doc, paragraphs, i + 1);
        cancelRun(reader);
        return;
      }
    }

    if (i < paragraphs.length - 1 && isCurrentRun(reader, generation, doc)) {
      await Zotero.Promise.delay(REQUEST_GAP_MS);
    }
  }

  const state = runStates.get(reader);
  if (state && state.generation === generation) state.running = false;
}

async function prepareAndRun(reader: any, refreshOnly: boolean): Promise<void> {
  const doc = await ensureReadingMode(reader);
  const root = getDocumentRoot(doc);
  if (!root) throw new Error("无法访问 Zotero 阅读模式页面。");

  installStyles(doc);
  cancelRun(reader);

  if (refreshOnly) {
    clearFailedTranslations(doc);
  }

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

  for (const paragraph of paragraphs) {
    ensureTranslationBlock(doc, paragraph);
  }

  const generation = nextGeneration(reader);
  root.dataset.bilingualReaderRunning = "true";
  try {
    await translateParagraphs(reader, doc, itemID, itemKey, paragraphs, generation);
  } finally {
    const liveRoot = getDocumentRoot(getSDTDocument(reader) || doc);
    if (liveRoot) delete liveRoot.dataset.bilingualReaderRunning;
  }
}

export async function toggleBilingualReading(reader: any): Promise<void> {
  try {
    const doc = await ensureReadingMode(reader);

    if (doc.querySelector(`.${TRANSLATION_CLASS}`)) {
      cancelRun(reader);
      clearTranslations(doc);
      return;
    }

    await prepareAndRun(reader, false);
  } catch (error: any) {
    if (!isDeadObjectError(error)) {
      showError(reader, error?.message || String(error));
    }
  }
}

export async function refreshBilingualReading(reader: any): Promise<void> {
  try {
    cancelRun(reader);
    await prepareAndRun(reader, true);
  } catch (error: any) {
    if (!isDeadObjectError(error)) {
      showError(reader, error?.message || String(error));
    }
  }
}

function getPromptWindow(reader: any): any {
  try {
    return reader?._iframeWindow || Zotero.getMainWindow();
  } catch (_) {
    return Zotero.getMainWindow();
  }
}

export function configureTranslation(reader: any): void {
  const win = getPromptWindow(reader);
  if (!win?.prompt) {
    showError(reader, "无法打开翻译设置窗口。");
    return;
  }

  const currentEngine = getEngine();
  const answer = win.prompt(
    "选择翻译后端：\n1 = Translate for Zotero（使用其当前默认服务）\n2 = Ollama（本地或 Ollama Cloud）",
    currentEngine === "ollama" ? "2" : "1",
  );
  if (answer === null) return;

  if (String(answer).trim() === "2") {
    const currentURL = getStringPref(OLLAMA_URL_PREF, DEFAULT_OLLAMA_URL);
    const url = win.prompt("Ollama 地址：", currentURL);
    if (url === null) return;

    const currentModel = getStringPref(OLLAMA_MODEL_PREF, DEFAULT_OLLAMA_MODEL);
    const model = win.prompt(
      "Ollama 模型名称：\n本地推荐：gpt-oss:20b\n云端可用：gpt-oss:120b-cloud",
      currentModel,
    );
    if (model === null) return;

    setStringPref(ENGINE_PREF, "ollama");
    setStringPref(OLLAMA_URL_PREF, String(url).trim() || DEFAULT_OLLAMA_URL);
    setStringPref(OLLAMA_MODEL_PREF, String(model).trim() || DEFAULT_OLLAMA_MODEL);
    win.alert?.("已切换为 Ollama。点击 🔄 可取消旧任务并重试失败段落。");
    return;
  }

  setStringPref(ENGINE_PREF, "pdftranslate");
  win.alert?.(
    "已切换为 Translate for Zotero。请先在 Translate for Zotero 中选好新的翻译服务，然后点击 🔄 重试失败段落。",
  );
}

function createToolbarButton(
  doc: Document,
  className: string,
  text: string,
  title: string,
  onClick: (event: Event) => void,
): HTMLButtonElement {
  const button = doc.createElement("button");
  button.className = `toolbar-button ${className}`;
  button.type = "button";
  button.tabIndex = -1;
  button.textContent = text;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.style.minWidth = "34px";
  button.style.paddingInline = "5px";
  button.addEventListener("click", (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick(event);
  });
  return button;
}

function renderToolbar(event: any): void {
  const { reader, doc, append } = event || {};
  if (!reader || reader.type !== "pdf" || !doc || typeof append !== "function") return;
  if (doc.querySelector(`.${TOOLBAR_BUTTON_CLASS}`)) return;

  append(
    createToolbarButton(
      doc,
      TOOLBAR_BUTTON_CLASS,
      "中英",
      "开启/关闭中英段落对照",
      () => void toggleBilingualReading(reader),
    ),
  );

  append(
    createToolbarButton(
      doc,
      REFRESH_BUTTON_CLASS,
      "🔄",
      "取消当前翻译，清除失败/等待结果，并用当前翻译引擎重试",
      () => void refreshBilingualReading(reader),
    ),
  );

  append(
    createToolbarButton(doc, SETTINGS_BUTTON_CLASS, "⚙", "选择 Translate for Zotero 或 Ollama", () =>
      configureTranslation(reader),
    ),
  );
}

function cleanupReader(reader: any): void {
  cancelRun(reader);

  const sdtDoc = getSDTDocument(reader);
  if (sdtDoc) clearTranslations(sdtDoc);

  let toolbarDoc: Document | undefined;
  try {
    toolbarDoc = reader?._iframeWindow?.document as Document | undefined;
  } catch (_) {
    toolbarDoc = undefined;
  }

  const buttons = toolbarDoc
    ? (Array.from(
        toolbarDoc.querySelectorAll(
          `.${TOOLBAR_BUTTON_CLASS}, .${REFRESH_BUTTON_CLASS}, .${SETTINGS_BUTTON_CLASS}`,
        ),
      ) as HTMLElement[])
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
