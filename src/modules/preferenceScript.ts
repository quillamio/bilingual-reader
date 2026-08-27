import {
  DEFAULT_MAX_CHARS_PER_REQUEST,
  DEFAULT_MAX_BATCH_PARAGRAPHS,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_CONSECUTIVE_ERRORS,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
  DEFAULT_REQUEST_GAP_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SKIP_LAST_PAGES,
  DEFAULT_WORDWISE_COLOR,
  DEFAULT_WORDWISE_DENSITY,
  DEFAULT_WORDWISE_DOMAIN,
  DEFAULT_WORDWISE_LEVEL,
  DEFAULT_WORDWISE_POSITION,
  DEFAULT_WORDWISE_SHOW_ACADEMIC,
  DEFAULT_WORDWISE_SHOW_PROFESSIONAL,
  getEngine,
  getMaxCharsPerRequest,
  getMaxBatchParagraphs,
  getMaxConcurrent,
  getMaxConsecutiveErrors,
  getOllamaModel,
  getOllamaURL,
  getPDFTranslateService,
  getRequestGapMs,
  getRequestTimeoutMs,
  getSkipLastPages,
  getWordWiseColor,
  getWordWiseDensity,
  getWordWiseDomain,
  getWordWiseLevel,
  getWordWisePosition,
  getWordWiseShowAcademic,
  getWordWiseShowProfessional,
  setEngine,
  setMaxCharsPerRequest,
  setMaxBatchParagraphs,
  setMaxConcurrent,
  setMaxConsecutiveErrors,
  setOllamaModel,
  setOllamaURL,
  setPDFTranslateService,
  setRequestGapMs,
  setRequestTimeoutMs,
  setSkipLastPages,
  setWordWiseColor,
  setWordWiseDensity,
  setWordWiseDomain,
  setWordWiseLevel,
  setWordWisePosition,
  setWordWiseShowAcademic,
  setWordWiseShowProfessional,
  type TranslationEngine,
  type WordWiseDensity,
  type WordWiseDomain,
  type WordWiseLevel,
  type WordWisePosition,
} from "../settings";
import { clearTranslationCache, getTranslationCacheStats } from "../translationCache";

const PROJECT_URL = "https://github.com/quillamio/bilingual-reader";

function getElement<T extends HTMLElement>(doc: Document, id: string): T | null {
  return doc.getElementById(id) as T | null;
}

function setStatus(doc: Document, message: string): void {
  const status = getElement<HTMLElement>(doc, "bilingualreader-settings-status");
  if (status) status.textContent = message;
}

function updateBackendVisibility(doc: Document): void {
  const engine = getElement<HTMLSelectElement>(doc, "bilingualreader-engine")?.value;
  const pdfSection = getElement<HTMLElement>(doc, "bilingualreader-pdftranslate-section");
  const ollamaSection = getElement<HTMLElement>(doc, "bilingualreader-ollama-section");
  if (pdfSection) pdfSection.hidden = engine !== "pdftranslate";
  if (ollamaSection) ollamaSection.hidden = engine !== "ollama";
}

function readNumberInput(doc: Document, id: string, fallback: number): number {
  const input = getElement<HTMLInputElement>(doc, id);
  const value = Number(input?.value);
  return Number.isFinite(value) ? value : fallback;
}

function normalizeWordWiseLevel(value: string): WordWiseLevel {
  if (value === "kaoyan" || value === "toefl-ielts" || value === "gre") return value;
  return "cet6";
}

function normalizeWordWiseDomain(value: string): WordWiseDomain {
  if (
    value === "general" ||
    value === "medical" ||
    value === "engineering" ||
    value === "computer" ||
    value === "social"
  ) {
    return value;
  }
  return "auto";
}

function normalizeWordWiseDensity(value: string): WordWiseDensity {
  if (value === "few" || value === "many" || value === "rich" || value === "all") return value;
  return "standard";
}

function saveSettings(doc: Document): void {
  const engineValue = getElement<HTMLSelectElement>(doc, "bilingualreader-engine")?.value;
  const engine: TranslationEngine = engineValue === "ollama" ? "ollama" : "pdftranslate";
  const service =
    getElement<HTMLSelectElement>(doc, "bilingualreader-pdftranslate-service")?.value || "";
  const url =
    getElement<HTMLInputElement>(doc, "bilingualreader-ollama-url")?.value || DEFAULT_OLLAMA_URL;
  const model =
    getElement<HTMLInputElement>(doc, "bilingualreader-ollama-model")?.value ||
    DEFAULT_OLLAMA_MODEL;
  const wordWiseColor =
    getElement<HTMLInputElement>(doc, "bilingualreader-wordwise-color")?.value ||
    DEFAULT_WORDWISE_COLOR;
  const wordWisePositionValue =
    getElement<HTMLSelectElement>(doc, "bilingualreader-wordwise-position")?.value ||
    DEFAULT_WORDWISE_POSITION;
  const wordWisePosition: WordWisePosition =
    wordWisePositionValue === "under" ? "under" : "over";
  const wordWiseLevel = normalizeWordWiseLevel(
    getElement<HTMLSelectElement>(doc, "bilingualreader-wordwise-level")?.value ||
      DEFAULT_WORDWISE_LEVEL,
  );
  const wordWiseDomain = normalizeWordWiseDomain(
    getElement<HTMLSelectElement>(doc, "bilingualreader-wordwise-domain")?.value ||
      DEFAULT_WORDWISE_DOMAIN,
  );
  const wordWiseDensity = normalizeWordWiseDensity(
    getElement<HTMLSelectElement>(doc, "bilingualreader-wordwise-density")?.value ||
      DEFAULT_WORDWISE_DENSITY,
  );
  const wordWiseAcademic =
    getElement<HTMLInputElement>(doc, "bilingualreader-wordwise-academic")?.checked ??
    DEFAULT_WORDWISE_SHOW_ACADEMIC;
  const wordWiseProfessional =
    getElement<HTMLInputElement>(doc, "bilingualreader-wordwise-professional")?.checked ??
    DEFAULT_WORDWISE_SHOW_PROFESSIONAL;

  setEngine(engine);
  setPDFTranslateService(service);
  setOllamaURL(url);
  setOllamaModel(model);
  setWordWiseColor(wordWiseColor);
  setWordWisePosition(wordWisePosition);
  setWordWiseLevel(wordWiseLevel);
  setWordWiseDomain(wordWiseDomain);
  setWordWiseDensity(wordWiseDensity);
  setWordWiseShowAcademic(wordWiseAcademic);
  setWordWiseShowProfessional(wordWiseProfessional);
  setSkipLastPages(
    readNumberInput(doc, "bilingualreader-skip-last-pages", DEFAULT_SKIP_LAST_PAGES),
  );
  setMaxConcurrent(readNumberInput(doc, "bilingualreader-max-concurrent", DEFAULT_MAX_CONCURRENT));
  setRequestGapMs(readNumberInput(doc, "bilingualreader-request-gap", DEFAULT_REQUEST_GAP_MS));
  setMaxCharsPerRequest(
    readNumberInput(doc, "bilingualreader-max-chars", DEFAULT_MAX_CHARS_PER_REQUEST),
  );
  setMaxBatchParagraphs(
    readNumberInput(doc, "bilingualreader-max-batch-paragraphs", DEFAULT_MAX_BATCH_PARAGRAPHS),
  );
  setMaxConsecutiveErrors(
    readNumberInput(doc, "bilingualreader-max-errors", DEFAULT_MAX_CONSECUTIVE_ERRORS),
  );
  setRequestTimeoutMs(
    readNumberInput(doc, "bilingualreader-request-timeout", DEFAULT_REQUEST_TIMEOUT_MS),
  );

  setStatus(doc, "设置已保存。翻译参数回到 PDF 后点击 🔄 应用；生词参数下次点击 🎰 时应用。");
}

async function testOllama(doc: Document): Promise<void> {
  const url = (
    getElement<HTMLInputElement>(doc, "bilingualreader-ollama-url")?.value || DEFAULT_OLLAMA_URL
  ).replace(/\/+$/, "");
  const model =
    getElement<HTMLInputElement>(doc, "bilingualreader-ollama-model")?.value ||
    DEFAULT_OLLAMA_MODEL;

  const button = getElement<HTMLButtonElement>(doc, "bilingualreader-test-ollama");
  if (button?.disabled) return;
  if (button) button.disabled = true;
  setStatus(doc, `正在连接 ${url} …`);
  try {
    const xhr = await Zotero.HTTP.request("GET", `${url}/api/tags`, {
      responseType: "json",
      timeout: 15000,
    });
    if (!xhr || xhr.status < 200 || xhr.status >= 300) {
      throw new Error(`HTTP ${xhr?.status || "unknown"}`);
    }

    const response: any = xhr.response;
    const models = Array.isArray(response?.models)
      ? response.models
          .map((entry: any) => String(entry?.name || entry?.model || ""))
          .filter(Boolean)
      : [];
    const hasModel = models.includes(model);
    if (models.length) {
      setStatus(
        doc,
        hasModel
          ? `Ollama 连接成功，并检测到模型 ${model}。`
          : `Ollama 连接成功，但模型列表中未发现 ${model}。已检测：${models.slice(0, 8).join(", ")}`,
      );
    } else {
      setStatus(doc, "Ollama 连接成功。未读取到本地模型列表；云模型仍可能可以直接调用。");
    }
  } catch (error: any) {
    setStatus(doc, `Ollama 连接失败：${error?.message || String(error)}`);
  } finally {
    if (button) button.disabled = false;
  }
}

function updateCacheStatus(doc: Document): void {
  const status = getElement<HTMLElement>(doc, "bilingualreader-cache-status");
  if (!status) return;
  const stats = getTranslationCacheStats();
  const sizeMiB = ((stats.chars * 2) / (1024 * 1024)).toFixed(1);
  status.textContent = `缓存 ${stats.entries} 段，约 ${sizeMiB} MiB（按 UTF-16 估算）。`;
}

function clearCache(doc: Document): void {
  const removed = clearTranslationCache();
  const sizeMiB = ((removed.chars * 2) / (1024 * 1024)).toFixed(1);
  setStatus(doc, `已清除 ${removed.entries} 个缓存项，约 ${sizeMiB} MiB。`);
  updateCacheStatus(doc);
}

function populatePDFTranslateServices(doc: Document): void {
  const api = (Zotero as any).PDFTranslate?.api;
  const target = getElement<HTMLElement>(doc, "bilingualreader-pdftranslate-status");
  const select = getElement<HTMLSelectElement>(doc, "bilingualreader-pdftranslate-service");
  if (!target || !select) return;

  select.textContent = "";
  const defaultOption = doc.createElementNS("http://www.w3.org/1999/xhtml", "option");
  defaultOption.setAttribute("value", "");
  defaultOption.textContent = "跟随 Translate for Zotero 当前默认服务";
  select.append(defaultOption);

  if (!api?.translate) {
    target.textContent = "未检测到 Translate for Zotero。请先安装并启用该插件。";
    select.value = "";
    return;
  }

  let version = "";
  let services: any[] = [];
  try {
    version = api.getVersion?.() || "";
    const available = api.getServices?.();
    services = Array.isArray(available) ? available : [];
  } catch (_) {
    services = [];
  }

  for (const service of services) {
    if (service?.type && service.type !== "sentence") continue;
    const id = String(service?.id || "").trim();
    if (!id) continue;
    const option = doc.createElementNS("http://www.w3.org/1999/xhtml", "option");
    option.setAttribute("value", id);
    option.textContent = String(service?.name || id);
    select.append(option);
  }

  const configured = getPDFTranslateService();
  const serviceOptions = Array.from(select.querySelectorAll("option")) as HTMLOptionElement[];
  const hasConfigured = serviceOptions.some((option) => option.value === configured);
  select.value = hasConfigured ? configured : "";

  target.textContent = version
    ? `已检测到 Translate for Zotero ${version}。默认推荐使用该后端。`
    : "已检测到 Translate for Zotero。默认推荐使用该后端。";
}

function registerProjectLink(doc: Document): void {
  getElement<HTMLAnchorElement>(doc, "bilingualreader-github-link")?.addEventListener(
    "click",
    (event) => {
      event.preventDefault();
      const launcher = (Zotero as any).launchURL;
      if (typeof launcher === "function") launcher(PROJECT_URL);
      else doc.defaultView?.open(PROJECT_URL, "_blank");
    },
  );
}

function registerWordWiseSettingMessages(doc: Document): void {
  const ids = [
    "bilingualreader-wordwise-level",
    "bilingualreader-wordwise-domain",
    "bilingualreader-wordwise-density",
    "bilingualreader-wordwise-academic",
    "bilingualreader-wordwise-professional",
  ];
  for (const id of ids) {
    getElement<HTMLElement>(doc, id)?.addEventListener("change", () => {
      setStatus(doc, "生词提示规则已修改，保存后下次点击 🎰 应用。");
    });
  }
}

export async function registerPrefsScripts(window: Window): Promise<void> {
  const doc = window.document;
  const root = getElement<HTMLElement>(doc, "bilingualreader-settings-root");
  if (!root || root.dataset.initialized === "true") return;
  root.dataset.initialized = "true";

  const engine = getElement<HTMLSelectElement>(doc, "bilingualreader-engine");
  const url = getElement<HTMLInputElement>(doc, "bilingualreader-ollama-url");
  const model = getElement<HTMLInputElement>(doc, "bilingualreader-ollama-model");
  const skipLastPages = getElement<HTMLInputElement>(doc, "bilingualreader-skip-last-pages");
  const maxConcurrent = getElement<HTMLInputElement>(doc, "bilingualreader-max-concurrent");
  const gap = getElement<HTMLInputElement>(doc, "bilingualreader-request-gap");
  const maxChars = getElement<HTMLInputElement>(doc, "bilingualreader-max-chars");
  const maxBatchParagraphs = getElement<HTMLInputElement>(
    doc,
    "bilingualreader-max-batch-paragraphs",
  );
  const maxErrors = getElement<HTMLInputElement>(doc, "bilingualreader-max-errors");
  const requestTimeout = getElement<HTMLInputElement>(doc, "bilingualreader-request-timeout");
  const wordWiseColor = getElement<HTMLInputElement>(doc, "bilingualreader-wordwise-color");
  const wordWisePosition = getElement<HTMLSelectElement>(doc, "bilingualreader-wordwise-position");
  const wordWiseLevel = getElement<HTMLSelectElement>(doc, "bilingualreader-wordwise-level");
  const wordWiseDomain = getElement<HTMLSelectElement>(doc, "bilingualreader-wordwise-domain");
  const wordWiseDensity = getElement<HTMLSelectElement>(doc, "bilingualreader-wordwise-density");
  const wordWiseAcademic = getElement<HTMLInputElement>(doc, "bilingualreader-wordwise-academic");
  const wordWiseProfessional = getElement<HTMLInputElement>(
    doc,
    "bilingualreader-wordwise-professional",
  );

  if (engine) engine.value = getEngine();
  if (url) url.value = getOllamaURL();
  if (model) model.value = getOllamaModel();
  if (skipLastPages) skipLastPages.value = String(getSkipLastPages());
  if (maxConcurrent) maxConcurrent.value = String(getMaxConcurrent());
  if (gap) gap.value = String(getRequestGapMs());
  if (maxChars) maxChars.value = String(getMaxCharsPerRequest());
  if (maxBatchParagraphs) maxBatchParagraphs.value = String(getMaxBatchParagraphs());
  if (maxErrors) maxErrors.value = String(getMaxConsecutiveErrors());
  if (requestTimeout) requestTimeout.value = String(getRequestTimeoutMs());
  if (wordWiseColor) wordWiseColor.value = getWordWiseColor();
  if (wordWisePosition) wordWisePosition.value = getWordWisePosition();
  if (wordWiseLevel) wordWiseLevel.value = getWordWiseLevel();
  if (wordWiseDomain) wordWiseDomain.value = getWordWiseDomain();
  if (wordWiseDensity) wordWiseDensity.value = getWordWiseDensity();
  if (wordWiseAcademic) wordWiseAcademic.checked = getWordWiseShowAcademic();
  if (wordWiseProfessional) wordWiseProfessional.checked = getWordWiseShowProfessional();

  updateBackendVisibility(doc);
  populatePDFTranslateServices(doc);
  updateCacheStatus(doc);
  registerProjectLink(doc);
  registerWordWiseSettingMessages(doc);

  engine?.addEventListener("change", () => {
    updateBackendVisibility(doc);
    setStatus(doc, "翻译后端已修改，点击“保存设置”后生效。");
  });

  getElement<HTMLSelectElement>(doc, "bilingualreader-pdftranslate-service")?.addEventListener(
    "change",
    () => {
      setStatus(doc, "Translate for Zotero 服务已修改，保存后回到 PDF 点击 🔄 应用。");
    },
  );

  wordWiseColor?.addEventListener("input", () => {
    setStatus(doc, `生词提示颜色已选择 ${wordWiseColor.value}，保存后下次点击 🎰 应用。`);
  });
  wordWisePosition?.addEventListener("change", () => {
    setStatus(doc, "生词释义位置已修改，保存后下次点击 🎰 应用。");
  });

  getElement<HTMLButtonElement>(doc, "bilingualreader-save")?.addEventListener("click", () => {
    saveSettings(doc);
  });

  getElement<HTMLButtonElement>(doc, "bilingualreader-test-ollama")?.addEventListener(
    "click",
    () => {
      void testOllama(doc);
    },
  );

  getElement<HTMLButtonElement>(doc, "bilingualreader-clear-cache")?.addEventListener(
    "click",
    () => {
      clearCache(doc);
    },
  );
}
