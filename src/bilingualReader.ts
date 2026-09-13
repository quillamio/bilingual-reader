import {
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
  getCacheEngineTag,
  getEngine,
  getMaxBatchParagraphs,
  getMaxCharsPerRequest,
  getMaxConcurrent,
  getMaxConsecutiveErrors,
  getOllamaModel,
  getOllamaURL,
  getPDFTranslateService,
  getRequestGapMs,
  getRequestTimeoutMs,
  getSkipLastPages,
  setEngine,
  setOllamaModel,
  setOllamaURL,
  type TranslationEngine,
} from "./settings";
import {
  flushTranslationCacheIndex,
  loadCachedTranslation,
  saveCachedTranslation,
} from "./translationCache";
import {
  buildBatchPayload,
  packBatchItems,
  parseBatchResult,
  splitTextForRequest,
  type BatchInput,
} from "./translationPipeline";
import { CancellationToken } from "./cancellationToken";

const PLUGIN_ID = "bilingual-reader@zotero.local";
const TARGET_LANG = "zh-CN";
const TRANSLATION_CLASS = "bilingual-reader-translation";
const TOOLBAR_BUTTON_CLASS = "bilingual-reader-toolbar-button";
const REFRESH_BUTTON_CLASS = "bilingual-reader-refresh-button";
const STYLE_ID = "bilingual-reader-style";
const PREFERENCES_PANE_ID = "bilingual-reader-preferences";
const MAHJONG_EMOJI = "🀄";

interface ReaderParagraph {
  refPath: string;
  sourceText: string;
  sourceElement: HTMLElement;
  block?: HTMLDivElement;
  translation?: string;
  pageIndex?: number;
}

interface RunState {
  generation: number;
  running: boolean;
  cancellation?: CancellationToken;
}

const runStates = new WeakMap<object, RunState>();

interface TranslationResponse {
  text: string;
  engineTag: string;
}

interface TranslationJobItem extends BatchInput {
  paragraphIndex: number;
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

class RunCancelledError extends Error {
  constructor() {
    super("翻译任务已取消。");
    this.name = "RunCancelledError";
  }
}

function isCancellationError(error: unknown): boolean {
  return error instanceof RunCancelledError || /翻译任务已取消/u.test(String(error));
}

async function raceWithTimeoutAndCancellation<T>(
  request: Promise<T>,
  timeoutMs: number,
  cancellation: CancellationToken,
): Promise<T> {
  if (cancellation.cancelled) throw new RunCancelledError();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let removeCancelListener: () => void = () => undefined;
    const cleanup = () => {
      clearTimeout(timeoutID);
      removeCancelListener();
    };
    const finish = (handler: (value: any) => void, value: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      handler(value);
    };
    const onCancel = () => finish(reject, new RunCancelledError());

    const timeoutID = setTimeout(() => {
      finish(reject, new Error(`翻译请求超过 ${Math.round(timeoutMs / 1000)} 秒，已跳过。`));
    }, timeoutMs);
    removeCancelListener = cancellation.onCancel(onCancel);

    request.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

async function cancellableDelay(
  milliseconds: number,
  cancellation: CancellationToken,
): Promise<void> {
  if (milliseconds <= 0) return;
  if (cancellation.cancelled) throw new RunCancelledError();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let removeCancelListener: () => void = () => undefined;
    const finish = (handler: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutID);
      removeCancelListener();
      handler();
    };
    const onCancel = () => finish(() => reject(new RunCancelledError()));

    const timeoutID = setTimeout(() => finish(resolve), milliseconds);
    removeCancelListener = cancellation.onCancel(onCancel);
  });
}

async function translateWithPDFTranslate(
  text: string,
  itemID: number,
): Promise<TranslationResponse> {
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
  const actualService = String(task?.service || selectedService || "").trim();
  return { text: result, engineTag: getCacheEngineTag(actualService) };
}

async function translateWithOllama(text: string): Promise<TranslationResponse> {
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
          "你是专业的生物医学论文翻译助手。把用户提供的英文准确翻译为简体中文。保留基因、蛋白、药物、统计学符号、数字、单位、图表编号和文献引用；不要总结，不要解释，不要添加前言，只输出译文。如果出现 [[BRSEG_0000]] 这类分段标记，必须逐字原样保留标记及其顺序。",
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
    timeout: getRequestTimeoutMs(),
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
  return { text: result.trim(), engineTag: getCacheEngineTag() };
}

async function translateText(
  text: string,
  itemID: number,
  engine: TranslationEngine,
): Promise<TranslationResponse> {
  if (engine === "ollama") {
    return translateWithOllama(text);
  }
  return translateWithPDFTranslate(text, itemID);
}

async function translateTextLimited(
  text: string,
  request: (chunk: string) => Promise<TranslationResponse>,
): Promise<TranslationResponse> {
  const chunks = splitTextForRequest(text, getMaxCharsPerRequest());
  if (chunks.length === 1) {
    return request(chunks[0]);
  }

  const translated: string[] = [];
  let engineTag = "";
  for (const chunk of chunks) {
    const response = await request(chunk);
    translated.push(response.text);
    engineTag = response.engineTag;
  }
  return { text: translated.join(" ").trim(), engineTag };
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
  current.cancellation?.cancel();
  current.generation += 1;
  current.running = true;
  current.cancellation = new CancellationToken();
  runStates.set(reader, current);
  return current.generation;
}

function cancelRun(reader: any): void {
  const current = runStates.get(reader) || { generation: 0, running: false };
  current.cancellation?.cancel();
  current.generation += 1;
  current.running = false;
  current.cancellation = undefined;
  runStates.set(reader, current);
}

function isCurrentRun(reader: any, generation: number, doc: Document): boolean {
  const state = runStates.get(reader);
  if (
    !state ||
    !state.running ||
    state.generation !== generation ||
    state.cancellation?.cancelled
  ) {
    return false;
  }

  try {
    return getSDTDocument(reader) === doc && !!doc.querySelector("#sdt-content");
  } catch (_) {
    return false;
  }
}

function getRunCancellation(reader: any, generation: number): CancellationToken {
  const state = runStates.get(reader);
  if (!state?.running || state.generation !== generation || !state.cancellation) {
    throw new RunCancelledError();
  }
  return state.cancellation;
}

function finishRun(reader: any, generation: number): void {
  const state = runStates.get(reader);
  if (!state || state.generation !== generation) return;
  state.running = false;
  state.cancellation = undefined;
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
    if (
      start.length &&
      end.length &&
      compareRefPath(ref, start) >= 0 &&
      compareRefPath(ref, end) < 0
    ) {
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
      sourceElement: element,
      pageIndex,
      translation: loadCachedTranslation(itemKey, sourceText, engineTag, isFailureText),
    });
  }

  return paragraphs;
}

function ensureTranslationBlock(doc: Document, paragraph: ReaderParagraph): HTMLDivElement | null {
  if (paragraph.block?.ownerDocument === doc && paragraph.block.parentNode) {
    return paragraph.block;
  }

  const source = paragraph.sourceElement;
  if (source.ownerDocument !== doc || !source.parentNode) return null;

  const sibling = source.nextElementSibling as HTMLDivElement | null;
  if (
    sibling?.classList.contains(TRANSLATION_CLASS) &&
    sibling.dataset.sourceRefPath === paragraph.refPath
  ) {
    paragraph.block = sibling;
    return sibling;
  }

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
  paragraph.block = block;
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

function getViewportDistance(paragraph: ReaderParagraph, doc: Document): number {
  try {
    const rect = paragraph.sourceElement.getBoundingClientRect();
    const viewportHeight = doc.defaultView?.innerHeight || 0;
    if (rect.bottom >= 0 && rect.top <= viewportHeight) return 0;
    if (rect.top > viewportHeight) return rect.top - viewportHeight;
    return Math.abs(rect.bottom);
  } catch (_) {
    return Number.MAX_SAFE_INTEGER;
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
  const requestTimeoutMs = getRequestTimeoutMs();
  const configuredConcurrent = getMaxConcurrent();
  const concurrency = engine === "ollama" ? 1 : configuredConcurrent;
  const pendingIndexes = paragraphs
    .map((paragraph, index) => (paragraph.translation ? -1 : index))
    .filter((index) => index >= 0);
  const viewportDistances = new Map(
    pendingIndexes.map((index) => [index, getViewportDistance(paragraphs[index], doc)]),
  );
  pendingIndexes.sort(
    (a, b) =>
      (viewportDistances.get(a) ?? Number.MAX_SAFE_INTEGER) -
      (viewportDistances.get(b) ?? Number.MAX_SAFE_INTEGER),
  );

  if (!pendingIndexes.length) {
    finishRun(reader, generation);
    return;
  }

  const cancellation = getRunCancellation(reader, generation);
  const jobItems: TranslationJobItem[] = pendingIndexes.map((paragraphIndex) => ({
    id: String(paragraphIndex),
    paragraphIndex,
    text: paragraphs[paragraphIndex].sourceText,
  }));
  const jobs = packBatchItems(jobItems, getMaxCharsPerRequest(), getMaxBatchParagraphs());

  let cursor = 0;
  let completed = 0;
  let failureStreak = 0;
  let aborted = false;
  let nextStartAt = Date.now();

  const waitForStartSlot = async () => {
    if (cancellation.cancelled) throw new RunCancelledError();
    if (requestGapMs <= 0) return;
    const now = Date.now();
    const scheduled = Math.max(now, nextStartAt);
    nextStartAt = scheduled + requestGapMs;
    const wait = scheduled - now;
    await cancellableDelay(wait, cancellation);
  };

  const request = async (text: string): Promise<TranslationResponse> => {
    await waitForStartSlot();
    if (!isCurrentRun(reader, generation, doc)) throw new RunCancelledError();
    return raceWithTimeoutAndCancellation(
      translateText(text, itemID, engine),
      requestTimeoutMs,
      cancellation,
    );
  };

  const translateJob = async (
    job: TranslationJobItem[],
  ): Promise<Array<{ paragraphIndex: number; response: TranslationResponse }>> => {
    if (job.length === 1) {
      const response = await translateTextLimited(job[0].text, request);
      return [{ paragraphIndex: job[0].paragraphIndex, response }];
    }

    const batchResponse = await request(buildBatchPayload(job));
    const parsed = parseBatchResult(batchResponse.text, job.length);
    if (parsed) {
      return job.map((item, index) => ({
        paragraphIndex: item.paragraphIndex,
        response: { text: parsed[index], engineTag: batchResponse.engineTag },
      }));
    }

    // Some engines translate or remove structural markers. Retrying these few
    // items individually is slower, but guarantees paragraph alignment.
    const fallback: Array<{ paragraphIndex: number; response: TranslationResponse }> = [];
    for (const item of job) {
      fallback.push({
        paragraphIndex: item.paragraphIndex,
        response: await translateTextLimited(item.text, request),
      });
    }
    return fallback;
  };

  const worker = async () => {
    while (!aborted && isCurrentRun(reader, generation, doc)) {
      const slot = cursor++;
      if (slot >= jobs.length) return;
      const job = jobs[slot];

      for (const item of job) {
        const block = ensureTranslationBlock(doc, paragraphs[item.paragraphIndex]);
        if (!block) continue;
        block.dataset.state = "loading";
        block.textContent = `正在翻译…（已完成 ${completed}/${pendingIndexes.length}）`;
      }

      try {
        const results = await translateJob(job);
        if (!isCurrentRun(reader, generation, doc)) return;

        for (const { paragraphIndex, response } of results) {
          const paragraph = paragraphs[paragraphIndex];
          paragraph.translation = response.text;
          saveCachedTranslation(
            itemKey,
            paragraph.sourceText,
            response.text,
            response.engineTag || engineTag,
            isFailureText,
          );

          const liveBlock = paragraph.block;
          if (liveBlock?.parentNode) {
            liveBlock.dataset.state = "done";
            liveBlock.textContent = response.text;
          }
          completed += 1;
        }
        failureStreak = 0;
      } catch (error: any) {
        if (isCancellationError(error)) return;
        if (isDeadObjectError(error)) {
          aborted = true;
          cancelRun(reader);
          return;
        }
        if (!isCurrentRun(reader, generation, doc)) return;

        failureStreak += 1;
        for (const item of job) {
          const liveBlock = paragraphs[item.paragraphIndex].block;
          if (liveBlock?.parentNode) {
            liveBlock.dataset.state = "error";
            liveBlock.textContent = `翻译失败：${error?.message || String(error)}`;
          }
        }

        if (failureStreak >= maxErrors) {
          aborted = true;
          markUnfinishedPaused(doc, paragraphs);
          cancelRun(reader);
          return;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));

  finishRun(reader, generation);
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
    flushTranslationCacheIndex();
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
    if (!isDeadObjectError(error) && !isCancellationError(error)) {
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
    if (!isDeadObjectError(error) && !isCancellationError(error)) {
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
  try {
    const preferencesWindow = Zotero.Utilities.Internal.openPreferences(PREFERENCES_PANE_ID);
    if (preferencesWindow) return;
  } catch (error) {
    Zotero.logError(error as Error);
  }

  // Retain a minimal fallback for unusual installations where Zotero cannot
  // open a registered plugin preference pane.
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
  button.style.fontSize = "19px";
  button.style.lineHeight = "1";
  button.style.fontFamily = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  button.addEventListener("click", (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick(event);
  });
  return button;
}

export function renderBilingualToolbarButtons(event: any): void {
  const { reader, doc, append } = event || {};
  if (!reader || reader.type !== "pdf" || !doc || typeof append !== "function") return;

  if (!doc.querySelector(`.${TOOLBAR_BUTTON_CLASS}`)) {
    append(
      createToolbarButton(
        doc,
        TOOLBAR_BUTTON_CLASS,
        MAHJONG_EMOJI,
        "开启/关闭中英段落对照",
        () => void toggleBilingualReading(reader),
      ),
    );
  }

  if (!doc.querySelector(`.${REFRESH_BUTTON_CLASS}`)) {
    append(
      createToolbarButton(
        doc,
        REFRESH_BUTTON_CLASS,
        "🔄",
        "取消当前任务、清除错误结果，并按当前设置重新翻译",
        () => void refreshBilingualReading(reader),
      ),
    );
  }
}

export function cleanupBilingualReader(reader: any): void {
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
        toolbarDoc.querySelectorAll(`.${TOOLBAR_BUTTON_CLASS}, .${REFRESH_BUTTON_CLASS}`),
      ) as HTMLElement[])
    : [];
  for (const button of buttons) {
    button.remove();
  }
}
