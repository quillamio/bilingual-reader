import {
  DEFAULT_MAX_CONSECUTIVE_ERRORS,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
  DEFAULT_REQUEST_GAP_MS,
  getEngine,
  getMaxConsecutiveErrors,
  getOllamaModel,
  getOllamaURL,
  getRequestGapMs,
  setEngine,
  setMaxConsecutiveErrors,
  setOllamaModel,
  setOllamaURL,
  setRequestGapMs,
  type TranslationEngine,
} from "../settings";

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

function saveSettings(doc: Document): void {
  const engineValue = getElement<HTMLSelectElement>(doc, "bilingualreader-engine")?.value;
  const engine: TranslationEngine = engineValue === "ollama" ? "ollama" : "pdftranslate";
  const url =
    getElement<HTMLInputElement>(doc, "bilingualreader-ollama-url")?.value || DEFAULT_OLLAMA_URL;
  const model =
    getElement<HTMLInputElement>(doc, "bilingualreader-ollama-model")?.value ||
    DEFAULT_OLLAMA_MODEL;
  const gap = readNumberInput(
    doc,
    "bilingualreader-request-gap",
    DEFAULT_REQUEST_GAP_MS,
  );
  const maxErrors = readNumberInput(
    doc,
    "bilingualreader-max-errors",
    DEFAULT_MAX_CONSECUTIVE_ERRORS,
  );

  setEngine(engine);
  setOllamaURL(url);
  setOllamaModel(model);
  setRequestGapMs(gap);
  setMaxConsecutiveErrors(maxErrors);
  setStatus(doc, "设置已保存。正在翻译的论文请点击阅读器顶部 🔄 以应用新后端。 ");
}

async function testOllama(doc: Document): Promise<void> {
  const url = (
    getElement<HTMLInputElement>(doc, "bilingualreader-ollama-url")?.value || DEFAULT_OLLAMA_URL
  ).replace(/\/+$/, "");
  const model =
    getElement<HTMLInputElement>(doc, "bilingualreader-ollama-model")?.value ||
    DEFAULT_OLLAMA_MODEL;

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
      ? response.models.map((entry: any) => String(entry?.name || entry?.model || "")).filter(Boolean)
      : [];
    const hasModel = models.includes(model);
    if (models.length) {
      setStatus(
        doc,
        hasModel
          ? `Ollama 连接成功，并检测到模型 ${model}。`
          : `Ollama 连接成功，但当前模型列表中未发现 ${model}。已检测：${models.slice(0, 8).join(", ")}`,
      );
    } else {
      setStatus(doc, "Ollama 连接成功。未读取到本地模型列表；云模型仍可能可以直接调用。");
    }
  } catch (error: any) {
    setStatus(doc, `Ollama 连接失败：${error?.message || String(error)}`);
  }
}

function showTranslateForZoteroStatus(doc: Document): void {
  const api = (Zotero as any).PDFTranslate?.api;
  const target = getElement<HTMLElement>(doc, "bilingualreader-pdftranslate-status");
  if (!target) return;

  if (!api?.translate) {
    target.textContent = "未检测到 Translate for Zotero。请先安装并启用该插件。";
    return;
  }

  let version = "";
  try {
    version = api.getVersion?.() || "";
  } catch (_) {
    version = "";
  }
  target.textContent = version
    ? `已检测到 Translate for Zotero ${version}。具体翻译服务继续在 Translate for Zotero 自己的设置中选择。`
    : "已检测到 Translate for Zotero。具体翻译服务继续在 Translate for Zotero 自己的设置中选择。";
}

export async function registerPrefsScripts(window: Window): Promise<void> {
  const doc = window.document;
  const root = getElement<HTMLElement>(doc, "bilingualreader-settings-root");
  if (!root || root.dataset.initialized === "true") return;
  root.dataset.initialized = "true";

  const engine = getElement<HTMLSelectElement>(doc, "bilingualreader-engine");
  const url = getElement<HTMLInputElement>(doc, "bilingualreader-ollama-url");
  const model = getElement<HTMLInputElement>(doc, "bilingualreader-ollama-model");
  const gap = getElement<HTMLInputElement>(doc, "bilingualreader-request-gap");
  const maxErrors = getElement<HTMLInputElement>(doc, "bilingualreader-max-errors");

  if (engine) engine.value = getEngine();
  if (url) url.value = getOllamaURL();
  if (model) model.value = getOllamaModel();
  if (gap) gap.value = String(getRequestGapMs());
  if (maxErrors) maxErrors.value = String(getMaxConsecutiveErrors());

  updateBackendVisibility(doc);
  showTranslateForZoteroStatus(doc);

  engine?.addEventListener("change", () => {
    updateBackendVisibility(doc);
    setStatus(doc, "翻译后端已修改，点击“保存设置”后生效。 ");
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
}
