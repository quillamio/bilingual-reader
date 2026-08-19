import {
  DEFAULT_MAX_CONSECUTIVE_ERRORS,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
  DEFAULT_REQUEST_GAP_MS,
  getEngine,
  getMaxConsecutiveErrors,
  getOllamaModel,
  getOllamaURL,
  getPDFTranslateService,
  getRequestGapMs,
  setEngine,
  setMaxConsecutiveErrors,
  setOllamaModel,
  setOllamaURL,
  setPDFTranslateService,
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
  const service =
    getElement<HTMLSelectElement>(doc, "bilingualreader-pdftranslate-service")?.value || "";
  const url =
    getElement<HTMLInputElement>(doc, "bilingualreader-ollama-url")?.value || DEFAULT_OLLAMA_URL;
  const model =
    getElement<HTMLInputElement>(doc, "bilingualreader-ollama-model")?.value ||
    DEFAULT_OLLAMA_MODEL;
  const gap = readNumberInput(doc, "bilingualreader-request-gap", DEFAULT_REQUEST_GAP_MS);
  const maxErrors = readNumberInput(
    doc,
    "bilingualreader-max-errors",
    DEFAULT_MAX_CONSECUTIVE_ERRORS,
  );

  setEngine(engine);
  setPDFTranslateService(service);
  setOllamaURL(url);
  setOllamaModel(model);
  setRequestGapMs(gap);
  setMaxConsecutiveErrors(maxErrors);
  setStatus(doc, "设置已保存。正在翻译的论文请点击阅读器顶部 🔄 以应用新后端或新服务。");
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
    services = api.getServices?.() || [];
  } catch (_) {
    services = [];
  }

  for (const service of services) {
    const id = String(service?.id || "").trim();
    if (!id) continue;
    const option = doc.createElementNS("http://www.w3.org/1999/xhtml", "option");
    option.setAttribute("value", id);
    option.textContent = String(service?.name || id);
    select.append(option);
  }

  const configured = getPDFTranslateService();
  const hasConfigured = Array.from(select.options).some((option) => option.value === configured);
  select.value = hasConfigured ? configured : "";

  target.textContent = version
    ? `已检测到 Translate for Zotero ${version}。可在下方直接指定服务；选择“跟随默认服务”时仍由 Translate for Zotero 自己的设置决定。`
    : "已检测到 Translate for Zotero。可在下方直接指定服务；选择“跟随默认服务”时仍由 Translate for Zotero 自己的设置决定。";
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
  populatePDFTranslateServices(doc);

  engine?.addEventListener("change", () => {
    updateBackendVisibility(doc);
    setStatus(doc, "翻译后端已修改，点击“保存设置”后生效。");
  });

  getElement<HTMLSelectElement>(doc, "bilingualreader-pdftranslate-service")?.addEventListener(
    "change",
    () => {
      setStatus(doc, "Translate for Zotero 服务已修改，保存后回到 PDF 点击 🔄 应用。 ");
    },
  );

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
