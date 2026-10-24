import {
  DEFAULT_MAX_CHARS_PER_REQUEST,
  DEFAULT_MAX_BATCH_PARAGRAPHS,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_CONSECUTIVE_ERRORS,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
  DEFAULT_OPENAI_ENDPOINT,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENAI_PROMPT,
  DEFAULT_OPENAI_TEMPERATURE,
  DEFAULT_REQUEST_GAP_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SKIP_LAST_PAGES,
  getEngine,
  getFigureBackfillEnabled,
  getMaxCharsPerRequest,
  getMaxBatchParagraphs,
  getMaxConcurrent,
  getMaxConsecutiveErrors,
  getOllamaModel,
  getOllamaURL,
  getOpenAIApiKey,
  getOpenAIEndpoint,
  getOpenAIModel,
  getOpenAIPrompt,
  getOpenAITemperature,
  getRequestGapMs,
  getRequestTimeoutMs,
  getSkipLastPages,
  setEngine,
  setFigureBackfillEnabled,
  setMaxCharsPerRequest,
  setMaxBatchParagraphs,
  setMaxConcurrent,
  setMaxConsecutiveErrors,
  setOllamaModel,
  setOllamaURL,
  setOpenAIApiKey,
  setOpenAIEndpoint,
  setOpenAIModel,
  setOpenAIPrompt,
  setOpenAITemperature,
  setRequestGapMs,
  setRequestTimeoutMs,
  setSkipLastPages,
  type TranslationEngine,
} from "../settings";
import { requestOpenAITranslation } from "../openaiClient";
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
  const openaiSection = getElement<HTMLElement>(doc, "bilingualreader-openai-section");
  if (pdfSection) pdfSection.hidden = engine !== "pdftranslate";
  if (ollamaSection) ollamaSection.hidden = engine !== "ollama";
  if (openaiSection) openaiSection.hidden = engine !== "openai";
}

function readNumberInput(doc: Document, id: string, fallback: number): number {
  const input = getElement<HTMLInputElement>(doc, id);
  const value = Number(input?.value);
  return Number.isFinite(value) ? value : fallback;
}

function saveSettings(doc: Document): void {
  const engineValue = getElement<HTMLSelectElement>(doc, "bilingualreader-engine")?.value;
  const engine: TranslationEngine =
    engineValue === "ollama" ? "ollama" : engineValue === "openai" ? "openai" : "pdftranslate";
  const url =
    getElement<HTMLInputElement>(doc, "bilingualreader-ollama-url")?.value || DEFAULT_OLLAMA_URL;
  const model =
    getElement<HTMLInputElement>(doc, "bilingualreader-ollama-model")?.value ||
    DEFAULT_OLLAMA_MODEL;

  setEngine(engine);
  setOllamaURL(url);
  setOllamaModel(model);
  setOpenAIEndpoint(
    getElement<HTMLInputElement>(doc, "bilingualreader-openai-endpoint")?.value ||
      DEFAULT_OPENAI_ENDPOINT,
  );
  setOpenAIModel(
    getElement<HTMLInputElement>(doc, "bilingualreader-openai-model")?.value ||
      DEFAULT_OPENAI_MODEL,
  );
  setOpenAIApiKey(getElement<HTMLInputElement>(doc, "bilingualreader-openai-key")?.value || "");
  setOpenAIPrompt(
    getElement<HTMLTextAreaElement>(doc, "bilingualreader-openai-prompt")?.value ||
      DEFAULT_OPENAI_PROMPT,
  );
  setOpenAITemperature(
    readNumberInput(
      doc,
      "bilingualreader-openai-temperature",
      DEFAULT_OPENAI_TEMPERATURE,
    ),
  );
  setSkipLastPages(
    readNumberInput(doc, "bilingualreader-skip-last-pages", DEFAULT_SKIP_LAST_PAGES),
  );
  setFigureBackfillEnabled(
    !!getElement<HTMLInputElement>(doc, "bilingualreader-figure-backfill")?.checked,
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

  setStatus(doc, "设置已保存。返回正在阅读的 PDF 后点击 🔄 即可应用。 ");
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

const OPENAI_PRESETS: Record<
  string,
  { endpoint: string; model: string; status: string }
> = {
  bigmodel: {
    endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    model: "glm-4.7-flash",
    status: "已填入智谱 GLM-4.7-Flash（官方免费）。请填写 BigModel API Key。",
  },
  modelscope: {
    endpoint: "https://api-inference.modelscope.cn/v1/chat/completions",
    model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
    status:
      "已填入 ModelScope DeepSeek。若返回 401，请绑定实名阿里云账号；若返回 no provider，改用 Qwen/Qwen3.8-Flash-Next。",
  },
  siliconflow: {
    endpoint: "https://api.siliconflow.cn/v1/chat/completions",
    model: "deepseek-ai/DeepSeek-V3.2",
    status: "已填入 SiliconFlow DeepSeek-V3.2（按量计费）。请填写 SiliconFlow API Key。",
  },
  gemini: {
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: "gemini-3.6-flash",
    status:
      "已填入 Gemini API。Google AI Pro 订阅不含 API 额度，需使用 AI Studio 的 API Key 与独立计费/免费层。",
  },
};

function applyOpenAIPreset(doc: Document, presetKey: string): void {
  const preset = OPENAI_PRESETS[presetKey];
  if (!preset) return;
  const endpoint = getElement<HTMLInputElement>(doc, "bilingualreader-openai-endpoint");
  const model = getElement<HTMLInputElement>(doc, "bilingualreader-openai-model");
  if (endpoint) endpoint.value = preset.endpoint;
  if (model) model.value = preset.model;
  setStatus(doc, preset.status);
}

async function testOpenAI(doc: Document): Promise<void> {
  const endpoint =
    getElement<HTMLInputElement>(doc, "bilingualreader-openai-endpoint")?.value ||
    DEFAULT_OPENAI_ENDPOINT;
  const model =
    getElement<HTMLInputElement>(doc, "bilingualreader-openai-model")?.value ||
    DEFAULT_OPENAI_MODEL;
  const apiKey = getElement<HTMLInputElement>(doc, "bilingualreader-openai-key")?.value || "";
  const prompt =
    getElement<HTMLTextAreaElement>(doc, "bilingualreader-openai-prompt")?.value ||
    DEFAULT_OPENAI_PROMPT;
  const temperature = readNumberInput(
    doc,
    "bilingualreader-openai-temperature",
    DEFAULT_OPENAI_TEMPERATURE,
  );

  if (!apiKey.trim()) {
    setStatus(doc, "请先填写 API Key。");
    return;
  }

  const button = getElement<HTMLButtonElement>(doc, "bilingualreader-test-openai");
  if (button?.disabled) return;
  if (button) button.disabled = true;
  setStatus(doc, `正在测试 ${model} …`);
  try {
    const translated = await requestOpenAITranslation(
      {
        endpoint,
        apiKey,
        model,
        systemPrompt: prompt,
        temperature,
        timeoutMs: getRequestTimeoutMs(),
      },
      "Automatic first-arrival picking is a key step in seismic processing.",
    );
    setStatus(doc, `连接成功：${translated.slice(0, 120)}`);
  } catch (error: any) {
    setStatus(doc, `连接失败：${error?.message || String(error)}`);
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

function updatePDFTranslateStatus(doc: Document): void {
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
    ? `已检测到 Translate for Zotero ${version}。Bilingual Reader 将固定跟随它当前的默认服务。`
    : "已检测到 Translate for Zotero。Bilingual Reader 将固定跟随它当前的默认服务。";
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

export async function registerPrefsScripts(window: Window): Promise<void> {
  const doc = window.document;
  const root = getElement<HTMLElement>(doc, "bilingualreader-settings-root");
  if (!root || root.dataset.initialized === "true") return;
  root.dataset.initialized = "true";

  const engine = getElement<HTMLSelectElement>(doc, "bilingualreader-engine");
  const url = getElement<HTMLInputElement>(doc, "bilingualreader-ollama-url");
  const model = getElement<HTMLInputElement>(doc, "bilingualreader-ollama-model");
  const openaiEndpoint = getElement<HTMLInputElement>(doc, "bilingualreader-openai-endpoint");
  const openaiModel = getElement<HTMLInputElement>(doc, "bilingualreader-openai-model");
  const openaiKey = getElement<HTMLInputElement>(doc, "bilingualreader-openai-key");
  const openaiPrompt = getElement<HTMLTextAreaElement>(doc, "bilingualreader-openai-prompt");
  const openaiTemperature = getElement<HTMLInputElement>(
    doc,
    "bilingualreader-openai-temperature",
  );
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

  if (engine) engine.value = getEngine();
  if (url) url.value = getOllamaURL();
  if (model) model.value = getOllamaModel();
  if (openaiEndpoint) openaiEndpoint.value = getOpenAIEndpoint();
  if (openaiModel) openaiModel.value = getOpenAIModel();
  if (openaiKey) openaiKey.value = getOpenAIApiKey();
  if (openaiPrompt) openaiPrompt.value = getOpenAIPrompt();
  if (openaiTemperature) openaiTemperature.value = String(getOpenAITemperature());
  if (skipLastPages) skipLastPages.value = String(getSkipLastPages());
  const figureBackfill = getElement<HTMLInputElement>(doc, "bilingualreader-figure-backfill");
  if (figureBackfill) figureBackfill.checked = getFigureBackfillEnabled();
  if (maxConcurrent) maxConcurrent.value = String(getMaxConcurrent());
  if (gap) gap.value = String(getRequestGapMs());
  if (maxChars) maxChars.value = String(getMaxCharsPerRequest());
  if (maxBatchParagraphs) maxBatchParagraphs.value = String(getMaxBatchParagraphs());
  if (maxErrors) maxErrors.value = String(getMaxConsecutiveErrors());
  if (requestTimeout) requestTimeout.value = String(getRequestTimeoutMs());

  updateBackendVisibility(doc);
  updatePDFTranslateStatus(doc);
  updateCacheStatus(doc);
  registerProjectLink(doc);

  engine?.addEventListener("change", () => {
    updateBackendVisibility(doc);
    setStatus(doc, "翻译后端已修改，点击“保存设置”后生效。");
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

  getElement<HTMLButtonElement>(doc, "bilingualreader-openai-preset-bigmodel")?.addEventListener(
    "click",
    () => {
      applyOpenAIPreset(doc, "bigmodel");
    },
  );

  getElement<HTMLButtonElement>(doc, "bilingualreader-openai-preset-modelscope")?.addEventListener(
    "click",
    () => {
      applyOpenAIPreset(doc, "modelscope");
    },
  );

  getElement<HTMLButtonElement>(
    doc,
    "bilingualreader-openai-preset-siliconflow",
  )?.addEventListener("click", () => {
    applyOpenAIPreset(doc, "siliconflow");
  });

  getElement<HTMLButtonElement>(doc, "bilingualreader-openai-preset-gemini")?.addEventListener(
    "click",
    () => {
      applyOpenAIPreset(doc, "gemini");
    },
  );

  getElement<HTMLButtonElement>(doc, "bilingualreader-test-openai")?.addEventListener(
    "click",
    () => {
      void testOpenAI(doc);
    },
  );

  getElement<HTMLButtonElement>(doc, "bilingualreader-clear-cache")?.addEventListener(
    "click",
    () => {
      clearCache(doc);
    },
  );
}
