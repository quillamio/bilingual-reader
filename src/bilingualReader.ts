import {
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
  getCacheEngineTag,
  getEngine,
  getMaxCharsPerRequest,
  getMaxConcurrent,
  getMaxConsecutiveErrors,
  getOllamaModel,
  getOllamaURL,
  getPDFTranslateService,
  getRequestGapMs,
  getSkipLastPages,
  setEngine,
  setOllamaModel,
  setOllamaURL,
  type TranslationEngine,
} from "./settings";

const PLUGIN_ID = "bilingual-reader@zotero.local";
const BASE = "extensions.zotero.bilingualreader";
const TARGET_LANG = "zh-CN";
const TRANSLATION_CLASS = "bilingual-reader-translation";
const TOOLBAR_BUTTON_CLASS = "bilingual-reader-toolbar-button";
const REFRESH_BUTTON_CLASS = "bilingual-reader-refresh-button";
const SETTINGS_BUTTON_CLASS = "bilingual-reader-settings-button";
const STYLE_ID = "bilingual-reader-style";

interface ReaderParagraph {
  refPath: string;
  sourceText: string;
  translation?: string;
  pageIndex?: number;
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

function cacheKey(itemKey: string, sourceText: string, engineTag: string): string {
  return `${BASE}.cache.v3.${hash(engineTag)}.${itemKey}.${hash(sourceText)}.${TARGET_LANG}`;
}

function isFailureText(text: string): boolean {
  const value = text.trim();
  if (!value) return true;
  return (
    /^\[请求错误\]/u.test(value) ||
    /此翻译服务不可用/u.test(value) ||
    /(?:request|service|parse) error\s*:/iu.test(value) ||
    /HTTP\s+(?:GET|POST)?[^\n]*failed with status code/iu.test(value) ||
    /Translate for Zotero 未返回译文/u.test(value)
  );
}

function loadCached(itemKey: string, sourceText: string, engineTag: string): string | undefined {
  const key = cacheKey(itemKey, sourceText, engineTag);
  const value = (Zotero.Prefs as any).get(key);
  if (typeof value !== "string" || !value.trim()) return undefined;
  if (isFailureText(value)) {
    (Zotero.Prefs as any).set(key, "");
    return undefined;
  }
  return value;
}

function saveCached(
  itemKey: string,
  sourceText: string,
  translation: string,
  engineTag: string,
): void {
  if (isFailureText(translation)) return;
  (Zotero.Prefs as any).set(cacheKey(itemKey, sourceText, engineTag), translation);
}

async function translateWithPDFTranslate(text: string, itemID: number): Promise<string> {
  const pdfTranslate = (Zotero as any).PDFTranslate;
  if (!pdfTranslate?.api?.translate) {
    throw new Error(
      "未检测到 Translate for Zotero。请先安装并启用 zotero-pdf-translate，或在设置中切换为 Ollama。",
    );
  }

  const options: Record<string, any> = {
    pluginID: PLUGIN_ID,
    itemID,
    langto: TARGET_LANG,
  };
  const selectedService = getPDFTranslateService();
  if (selectedService) {
    options.service = selectedService;
  }

  const task = await pdfTranslate.api.translate(text, options);
  const result = String(task?.result || "").trim();

  if (task?.status && task.status !== "success") {
    throw new Error(result || "Translate for Zotero 翻译任务失败。");
  }
  if (!result || isFailureText(result)) {
    throw new Error(result || "Translate for Zotero 未返回译文，请检查翻译服务配置或网络状态。");
  }
  return result;
}

async function translateWithOllama(text: string): Promise<string> {
  const baseURL = getOllamaURL();
  const model = getOllamaModel();
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
      // Common validation below handles malformed responses.
    }
  }

  const result = response?.message?.content;
  if (!result || typeof result !== "string") {
    throw new Error("Ollama 未返回有效译文。请确认 Ollama 已启动、模型名称正确并可正常运行。");
  }
  return result.trim();
}

async function translateText(
  text: string,
  itemID: number,
  engine: TranslationEngine,
): Promise<string> {
  if (engine === "ollama") {
    return translateWithOllama(text);
  }
  return translateWithPDFTranslate(text, itemID);
}

function hardSplitText(text: string, maxChars: number): string[] {
  const result: string[] = [];
  let rest = text.trim();
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1);
    let splitAt = Math.max(
      window.lastIndexOf(" "),
      window.lastIndexOf(", "),
      window.lastIndexOf("; "),
    );
    if (splitAt < Math.floor(maxChars * 0.55)) splitAt = maxChars;
    const chunk = rest.slice(0, splitAt).trim();
    if (chunk) result.push(chunk);
    rest = rest.slice(splitAt).trim();
  }
  if (rest) result.push(rest);
  return result;
}

function splitTextForRequest(text: string, maxChars: number): string[] {
  const source = text.trim();
  if (source.length <= maxChars) return [source];

  const sentences = source.match(/[^.!?。！？；;]+(?:[.!?。！？；;]+|$)/gu) || [source];
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = "";
  };

  for (const sentenceRaw of sentences) {
    const sentence = sentenceRaw.trim();
    if (!sentence) continue;

    if (sentence.length > maxChars) {
      flush();
      chunks.push(...hardSplitText(sentence, maxChars));
      continue;
    }

    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > maxChars) {
      flush();
      current = sentence;
    } else {
      current = candidate;
    }
  }
  flush();
  return chunks.length ? chunks : hardSplitText(source, maxChars);
}

async function translateTextLimited(
  text: string,
  itemID: number,
  engine: TranslationEngine,
): Promise<string> {
  const chunks = splitTextForRequest(text, getMaxCharsPerRequest());
  if (chunks.length === 1) {
    return translateText(chunks[0], itemID, engine);
  }

  const translated: string[] = [];
  for (const chunk of chunks) {
    translated.push(await translateText(chunk, itemID, engine));
  }
  return translated.join(" ").trim();
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

function getSDTStructure(reader: any): any | null {
  try {
    const view = getActiveSDTView(reader);
    return view?.getData?.()?.structure || view?._structure || null;
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

function parseRefPath(refPath: string): number[] {
  return refPath
    .split(".")
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part));
}

function compareRefPath(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function getPageIndexForRef(structure: any, refPath: string): number | undefined {
  const ref = parseRefPath(refPath);
  if (!ref.length) return undefined;
  const pages = structure?.catalog?.pages;
  if (!Array.isArray(pages)) return undefined;

  for (let i = 0; i < pages.length; i++) {
    const range = pages[i]?.contentRange;
    if (!Array.isArray(range) || range.length !== 2) continue;
    const start = Array.isArray(range[0]) ? range[0] : [];
    const end = Array.isArray(range[1]) ? range[1] : [];
    if (start.length && end.length && compareRefPath(ref, start) >= 0 && compareRefPath(ref, end) < 0) {
      return i;
    }
  }
  return undefined;
}

function shouldSkipByPage(pageIndex: number | undefined, totalPages: number): boolean {
  const skipLastPages = getSkipLastPages();
  if (!skipLastPages || pageIndex === undefined || totalPages <= 0) return false;
  const firstSkippedPage = Math.max(0, totalPages - skipLastPages);
  return pageIndex >= firstSkippedPage;
}

function collectParagraphs(
  doc: Document,
  itemKey: string,
  engineTag: string,
  structure: any,
): ReaderParagraph[] {
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

  const totalPages = Array.isArray(structure?.catalog?.pages) ? structure.catalog.pages.length : 0;
  const elements = Array.from(doc.querySelectorAll(selector)) as HTMLElement[];
  const paragraphs: ReaderParagraph[] = [];

  for (const element of elements) {
    if (!isTranslatableElement(element)) continue;

    const sourceText = (element.textContent || "").replace(/\s+/g, " ").trim();
    if (sourceText.length < 2) continue;

    const refPath = element.dataset.refPath || "";
    const pageIndex = getPageIndexForRef(structure, refPath);
    if (shouldSkipByPage(pageIndex, totalPages)) continue;

    paragraphs.push({
      refPath,
      sourceText,
      pageIndex,
      translation: loadCached(itemKey, sourceText, engineTag),
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
  if (paragraph.pageIndex !== undefined) {
    block.dataset.sourcePage = String(paragraph.pageIndex + 1);
  }

  if (paragraph.translation) {
    block.dataset.state = "done";
    block.textContent = paragraph.translation;
  } else {
    block.dataset.state = "loading";
    block.textContent = "等待翻译…";
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

function markUnfinishedPaused(doc: Document, paragraphs: ReaderParagraph[]): void {
  for (const paragraph of paragraphs) {
    if (paragraph.translation) continue;
    const block = ensureTranslationBlock(doc, paragraph);
    if (!block || block.dataset.state === "error") continue;
    block.dataset.state = "paused";
    block.textContent = "已暂停：连续翻译失败。请检查翻译服务后点击 🔄 重试。";
  }
}

async function translateParagraphs(
  reader: any,
  doc: Document,
  itemID: number,
  itemKey: string,
  paragraphs: ReaderParagraph[],
  generation: number,
  engine: TranslationEngine,
  engineTag: string,
): Promise<void> {
  const maxErrors = getMaxConsecutiveErrors();
  const requestGapMs = getRequestGapMs();
  const configuredConcurrent = getMaxConcurrent();
  const concurrency = engine === "ollama" ? 1 : configuredConcurrent;
  const pendingIndexes = paragraphs
    .map((paragraph, index) => (paragraph.translation ? -1 : index))
    .filter((index) => index >= 0);

  if (!pendingIndexes.length) {
    const state = runStates.get(reader);
    if (state && state.generation === generation) state.running = false;
    return;
  }

  let cursor = 0;
  let failureStreak = 0;
  let aborted = false;
  let nextStartAt = Date.now();

  const waitForStartSlot = async () => {
    if (requestGapMs <= 0) return;
    const now = Date.now();
    const scheduled = Math.max(now, nextStartAt);
    nextStartAt = scheduled + requestGapMs;
    const wait = scheduled - now;
    if (wait > 0) await Zotero.Promise.delay(wait);
  };

  const worker = async () => {
    while (!aborted && isCurrentRun(reader, generation, doc)) {
      const slot = cursor++;
      if (slot >= pendingIndexes.length) return;
      const paragraphIndex = pendingIndexes[slot];
      const paragraph = paragraphs[paragraphIndex];
      const block = ensureTranslationBlock(doc, paragraph);
      if (!block) continue;

      block.dataset.state = "loading";
      block.textContent = `正在翻译…（${slot + 1}/${pendingIndexes.length}）`;

      await waitForStartSlot();
      if (aborted || !isCurrentRun(reader, generation, doc)) return;

      try {
        const translation = await translateTextLimited(paragraph.sourceText, itemID, engine);
        if (!isCurrentRun(reader, generation, doc)) return;

        paragraph.translation = translation;
        saveCached(itemKey, paragraph.sourceText, translation, engineTag);
        failureStreak = 0;

        const liveBlock = findTranslationBlock(doc, paragraph.refPath);
        if (liveBlock) {
          liveBlock.dataset.state = "done";
          liveBlock.textContent = translation;
        }
      } catch (error: any) {
        if (isDeadObjectError(error)) {
          aborted = true;
          cancelRun(reader);
          return;
        }
        if (!isCurrentRun(reader, generation, doc)) return;

        failureStreak += 1;
        const liveBlock = findTranslationBlock(doc, paragraph.refPath);
        if (liveBlock) {
          liveBlock.dataset.state = "error";
          liveBlock.textContent = `翻译失败：${error?.message || String(error)}`;
        }

        if (failureStreak >= maxErrors) {
          aborted = true;
          cancelRun(reader);
          markUnfinishedPaused(doc, paragraphs);
          return;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, pendingIndexes.length) }, () => worker()));

  const state = runStates.get(reader);
  if (state && state.generation === generation) state.running = false;
}

async function prepareAndRun(reader: any, refresh: boolean): Promise<void> {
  const doc = await ensureReadingMode(reader);
  const root = getDocumentRoot(doc);
  if (!root) throw new Error("无法访问 Zotero 阅读模式页面。");

  installStyles(doc);
  cancelRun(reader);

  if (refresh) {
    clearTranslations(doc);
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

  const engine = getEngine();
  const engineTag = getCacheEngineTag();
  const structure = getSDTStructure(reader);
  const paragraphs = collectParagraphs(doc, itemKey, engineTag, structure);
  if (!paragraphs.length) {
    throw new Error("当前阅读模式中没有检测到可翻译的正文段落，或已被末尾页数设置全部排除。");
  }

  for (const paragraph of paragraphs) {
    ensureTranslationBlock(doc, paragraph);
  }

  const generation = nextGeneration(reader);
  root.dataset.bilingualReaderRunning = "true";
  try {
    await translateParagraphs(
      reader,
      doc,
      itemID,
      itemKey,
      paragraphs,
      generation,
      engine,
      engineTag,
    );
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
    const doc = await ensureReadingMode(reader);
    clearTranslations(doc);
    await Zotero.Promise.delay(30);
    await prepareAndRun(reader, false);
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
    showError(reader, "无法打开翻译设置窗口。请在 Zotero 设置 → 中英对照 中配置。");
    return;
  }

  const currentEngine = getEngine();
  const answer = win.prompt(
    "快速切换翻译后端：\n1 = Translate for Zotero（推荐）\n2 = Ollama\n\n完整设置请前往 Zotero 设置 → 中英对照。",
    currentEngine === "ollama" ? "2" : "1",
  );
  if (answer === null) return;

  if (String(answer).trim() === "2") {
    const url = win.prompt("Ollama 地址：", getOllamaURL() || DEFAULT_OLLAMA_URL);
    if (url === null) return;

    const model = win.prompt(
      "Ollama 模型名称：\n本地推荐：gpt-oss:20b\n云端可用：gpt-oss:120b-cloud",
      getOllamaModel() || DEFAULT_OLLAMA_MODEL,
    );
    if (model === null) return;

    setEngine("ollama");
    setOllamaURL(String(url));
    setOllamaModel(String(model));
    win.alert?.("已切换为 Ollama。点击 🔄 会清除旧结果并重新翻译。");
    return;
  }

  setEngine("pdftranslate");
  win.alert?.(
    "已切换为 Translate for Zotero。可在 Zotero 设置 → 中英对照 中指定具体服务，然后点击 🔄 重试。",
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
      "取消当前任务、清除错误结果，并按当前设置重新翻译",
      () => void refreshBilingualReading(reader),
    ),
  );

  append(
    createToolbarButton(doc, SETTINGS_BUTTON_CLASS, "⚙", "快速切换翻译后端", () =>
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
