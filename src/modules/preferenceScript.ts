import {
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_SKIP_LAST_PAGES,
  getCacheMaxEntries,
  getTranslateAllPages,
  setCacheMaxEntries,
  setTranslateAllPages,
  DEFAULT_OLLAMA_URL,
  getEngine,
  getFreeFallbackEnabled,
  setFreeFallbackEnabled,
  getFreeFallbackOrder,
  setFreeFallbackOrder,
  getPDFExportLayout,
  setPDFExportLayout,
  getMaxCharsPerRequest,
  getMaxBatchParagraphs,
  getMaxConcurrent,
  getMaxConsecutiveErrors,
  getOllamaModel,
  getOllamaURL,
  getRequestGapMs,
  getRequestTimeoutMs,
  getSkipLastPages,
  setEngine,
  setMaxCharsPerRequest,
  setMaxBatchParagraphs,
  setMaxConcurrent,
  setMaxConsecutiveErrors,
  setOllamaModel,
  setOllamaURL,
  setRequestGapMs,
  setRequestTimeoutMs,
  setSkipLastPages,
} from "../settings";
import { clearTranslationCache, enforceTranslationCacheLimit, getTranslationCacheStats } from "../translationCache";
import { clearTranslationCheckpoints, getCheckpointDocumentCount, getCheckpointEnabled, setCheckpointEnabled } from "../zoteroCheckpoint";
import {
  SERVICE_CATALOG,
  getServiceDefinition,
  DICTIONARY_ONLY_SERVICES,
  getServiceSetting,
  updateServiceSettings,
  isManagedService,
} from "../serviceCatalog";
import { translateNativeParagraph } from "../nativeTranslation";
import {
  getNativePDFBackend, setNativePDFBackend, getDoclingEndpoint, setDoclingEndpoint,
  checkDoclingConnection,
} from "../pdfNativeDocling";
import { isCloudParser } from "../pdfCloudModel";
import { checkMinerUConnection, getCloudKey, getCloudModel, setCloudKey, setCloudModel } from "../pdfCloudParsers";


const CLOUD_PROVIDERS = ["mineru", "mistral", "llamaparse"] as const;

const PROJECT_URL = "https://github.com/quillamio/bilingual-reader";

function getElement<T extends HTMLElement>(doc: Document, id: string): T | null {
  return doc.getElementById(id) as T | null;
}

function setStatus(doc: Document, message: string): void {
  const status = getElement<HTMLElement>(doc, "bilingualreader-settings-status");
  if (status) status.textContent = message;
}

type FeedbackState = "pending" | "success" | "error";

function setFeedback(doc: Document, name: string, message = "", state?: FeedbackState): void {
  const status = getElement<HTMLElement>(doc, "bilingualreader-" + name + "-status");
  if (!status) return;
  const palette = {
    pending: ["#1e40af", "#dbeafe"],
    success: ["#166534", "#dcfce7"],
    error: ["#991b1b", "#fee2e2"],
  };
  const [color, background] = state ? palette[state] : ["", ""];
  status.dataset.state = state || "";
  status.style.color = color;
  status.style.backgroundColor = background;
  status.style.padding = state ? "3px 6px" : "";
  status.style.borderRadius = state ? "4px" : "";
  status.textContent = message;
}

function onPreferenceEdit<T extends HTMLInputElement | HTMLSelectElement>(
  control: T | null,
  save: (control: T) => void,
  saveOnInput = true,
): void {
  const doc = control?.ownerDocument;
  if (!control || !doc) return;
  const commit = () => {
    try {
      const previousError = control.title;
      save(control);
      const status = getElement<HTMLElement>(doc, "bilingualreader-settings-status");
      if (previousError && status?.textContent === previousError) status.textContent = "";
      control.removeAttribute("aria-invalid");
      control.removeAttribute("title");
    } catch (error) {
      const message = (error as Error).message;
      control.setAttribute("aria-invalid", "true");
      control.title = message;
      setStatus(doc, message);
    }
  };
  control.addEventListener("change", commit);
  if (saveOnInput && control.localName === "input" && (control as HTMLInputElement).type !== "checkbox") {
    control.addEventListener("input", commit);
  }
}

function bindTextPreference(
  doc: Document, id: string, value: string, save: (value: string) => void,
): void {
  const input = getElement<HTMLInputElement>(doc, id);
  if (!input) return;
  input.value = value;
  onPreferenceEdit(input, (control) => save(control.value));
}

function updateBackendVisibility(doc: Document): void {
  const engine = getElement<HTMLSelectElement>(doc, "bilingualreader-engine")?.value;
  const pdfSection = getElement<HTMLElement>(doc, "bilingualreader-pdftranslate-section");
  const ollamaSection = getElement<HTMLElement>(doc, "bilingualreader-ollama-section");
  if (pdfSection) pdfSection.hidden = engine !== "pdftranslate";
  if (ollamaSection) ollamaSection.hidden = engine !== "ollama";
  const configSection = getElement<HTMLElement>(doc, "bilingualreader-service-config-section");
  if (configSection) configSection.hidden = !engine || !isManagedService(engine);
  renderServiceFields(doc, engine || "");
}


const HTML_NS = "http://www.w3.org/1999/xhtml";

function html(doc: Document, name: string): HTMLElement {
  return doc.createElementNS(HTML_NS, name) as HTMLElement;
}

function renderServiceSelector(doc: Document): void {
  const select = getElement<HTMLSelectElement>(doc, "bilingualreader-engine");
  if (!select) return;
  while (select.firstChild) select.removeChild(select.firstChild);
  const pdfTranslate = html(doc, "option") as HTMLOptionElement;
  pdfTranslate.value = "pdftranslate";
  pdfTranslate.textContent = "Translate for Zotero（默认）";
  select.append(pdfTranslate);

  const names: Record<string, string> = {
    free: "免 API Key（在线网页翻译）",
    api: "需 API Key（各自配置密钥）",
    local: "自托管服务（指定本地地址）",
  };
  for (const group of ["free", "api", "local"]) {
    const optgroup = html(doc, "optgroup") as HTMLOptGroupElement;
    optgroup.label = names[group];
    for (const service of SERVICE_CATALOG.filter((item) => item.group === group)) {
      const option = html(doc, "option") as HTMLOptionElement;
      option.value = service.id;
      option.textContent = service.help ? service.label + " · 不推荐" : service.label;
      optgroup.append(option);
    }
    select.append(optgroup);
  }
  const ollama = html(doc, "option") as HTMLOptionElement;
  ollama.value = "ollama";
  ollama.textContent = "Ollama 本地 / 云端";
  select.append(ollama);
}

function renderServiceFields(doc: Document, id: string): void {
  const target = getElement<HTMLElement>(doc, "bilingualreader-service-fields");
  const hint = getElement<HTMLElement>(doc, "bilingualreader-service-config-hint");
  if (!target) return;
  while (target.firstChild) target.removeChild(target.firstChild);
  const definition = getServiceDefinition(id);
  if (!definition) return;
  if (hint) {
    hint.textContent = definition.help || (definition.fields.length
      ? "密钥和服务配置保存在本机。"
      : "此服务无需配置。");
  }
  for (const field of definition.fields) {
    const wrap = html(doc, "div");
    wrap.style.display = "flex";
    wrap.style.alignItems = "center";
    wrap.style.gap = "12px";
    const label = html(doc, "label") as HTMLLabelElement;
    label.textContent = field.label;
    label.style.minWidth = "210px";
    label.style.maxWidth = "210px";
    const elementId = "bilingualreader-service-field-" + field.key;
    label.htmlFor = elementId;
    let input: HTMLInputElement | HTMLSelectElement;
    if (field.type === "select") {
      const select = html(doc, "select") as HTMLSelectElement;
      for (const optionSpec of field.options || []) {
        const option = html(doc, "option") as HTMLOptionElement;
        option.value = optionSpec.value;
        option.textContent = optionSpec.label;
        select.append(option);
      }
      input = select;
    } else {
      const textInput = html(doc, "input") as HTMLInputElement;
      textInput.type = field.type === "password" ? "password" : "text";
      textInput.autocomplete = "off";
      input = textInput;
    }
    input.id = elementId;
    input.style.flex = "1";
    input.style.minWidth = "200px";
    input.style.padding = "5px 6px";
    input.value = getServiceSetting(id, field.key);
    onPreferenceEdit(input, (control) => {
      if (control.value.trim() !== getServiceSetting(id, field.key)) setFeedback(doc, "engine");
      updateServiceSettings(id, { [field.key]: control.value });
    });
    wrap.append(label, input);
    target.append(wrap);
  }
}
async function testSelectedService(doc: Document): Promise<void> {
  const engine = getElement<HTMLSelectElement>(doc, "bilingualreader-engine")?.value || "";
  if (!isManagedService(engine)) return;
  const button = getElement<HTMLButtonElement>(doc, "bilingualreader-test-service");
  if (button?.disabled) return;
  const invalidField = doc.querySelector<HTMLElement>(
    '#bilingualreader-service-fields [aria-invalid="true"]',
  );
  if (invalidField) {
    invalidField.focus();
    setFeedback(doc, "engine", invalidField.title, "error");
    return;
  }
  if (button) button.disabled = true;
  const status = getElement<HTMLElement>(doc, "bilingualreader-engine-status");
  setFeedback(doc, "engine", "正在测试…", "pending");
  try {
    const result = await translateNativeParagraph("The patient received treatment.", engine);
    if (getEngine() === engine && status?.dataset.state === "pending") {
      setFeedback(doc, "engine", "连接成功 · " + result.slice(0, 80), "success");
    }
  } catch (error: any) {
    if (getEngine() === engine && status?.dataset.state === "pending") {
      setFeedback(doc, "engine", "测试失败 · " + (error?.message || "未知错误"), "error");
    }
  } finally {
    if (button) button.disabled = false;
  }
}

async function testMinerU(doc: Document): Promise<void> {
  const button = getElement<HTMLButtonElement>(doc, "bilingualreader-test-mineru");
  const status = getElement<HTMLElement>(doc, "bilingualreader-mineru-status");
  if (!button || button.disabled) return;
  button.disabled = true;
  setFeedback(doc, "mineru", "正在验证…", "pending");
  try {
    await checkMinerUConnection();
    if (status?.dataset.state === "pending") {
      setFeedback(doc, "mineru", "验证成功 · MinerU 已返回上传地址", "success");
    }
  } catch (error) {
    if (status?.dataset.state === "pending") {
      setFeedback(doc, "mineru", "验证失败 · " + (error as Error).message, "error");
    }
  } finally {
    button.disabled = false;
  }
}

async function testDocling(doc: Document): Promise<void> {
  const button = getElement<HTMLButtonElement>(doc, "bilingualreader-test-docling");
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try {
    const url = getElement<HTMLInputElement>(
      doc, "bilingualreader-docling-url",
    )?.value || getDoclingEndpoint();
    setFeedback(doc, "docling", "正在测试…", "pending");
    const connected = await checkDoclingConnection(url);
    setFeedback(doc, "docling", connected ? "连接成功" : "响应格式无效",
      connected ? "success" : "error");
  } catch (error: any) {
    setFeedback(doc, "docling", "连接失败 · " + String(error?.message || error), "error");
  } finally {
    if (button) button.disabled = false;
  }
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
  setFeedback(doc, "engine", "正在测试…", "pending");
  const status = getElement<HTMLElement>(doc, "bilingualreader-engine-status");
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
    if (getEngine() !== "ollama" || status?.dataset.state !== "pending") return;
    const hasModel = models.includes(model);
    if (models.length) {
      setFeedback(doc, "engine", hasModel ? `连接成功 · 已检测到 ${model}`
        : `连接成功 · 本地列表未找到 ${model}`, "success");
    } else {
      setFeedback(doc, "engine", "连接成功 · 本地模型列表为空", "success");
    }
  } catch (error: any) {
    if (getEngine() === "ollama" && status?.dataset.state === "pending") {
      setFeedback(doc, "engine", `连接失败 · ${error?.message || String(error)}`, "error");
    }
  } finally {
    if (button) button.disabled = false;
  }
}

function updateCacheStatus(doc: Document): void {
  const status = getElement<HTMLElement>(doc, "bilingualreader-cache-status");
  if (!status) return;
  const stats = getTranslationCacheStats();
  const sizeMiB = ((stats.chars * 2) / (1024 * 1024)).toFixed(1);
  status.textContent = `缓存 ${stats.entries} 段，约 ${sizeMiB} MiB（按 UTF-16 估算）；断点记录 ${getCheckpointDocumentCount()} 个附件。`;
}

function clearCache(doc: Document): void {
  const removed = clearTranslationCache();
  const checkpoints = clearTranslationCheckpoints();
  const sizeMiB = ((removed.chars * 2) / (1024 * 1024)).toFixed(1);
  setStatus(doc, `已清除 ${removed.entries} 个缓存项，约 ${sizeMiB} MiB，以及 ${checkpoints} 个附件的断点记录。`);
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

  target.textContent = `使用 Translate for Zotero${version ? " " + version : ""} 的默认服务。`;
}

function registerExternalLink(doc: Document, id: string, url: string): void {
  getElement<HTMLAnchorElement>(doc, id)?.addEventListener(
    "click",
    (event) => {
      event.preventDefault();
      const launcher = (Zotero as any).launchURL;
      if (typeof launcher === "function") launcher(url);
      else doc.defaultView?.open(url, "_blank");
    },
  );
}

export async function registerPrefsScripts(window: Window): Promise<void> {
  const doc = window.document;
  const root = getElement<HTMLElement>(doc, "bilingualreader-settings-root");
  if (!root || root.dataset.initialized === "true") return;
  root.dataset.initialized = "true";

  renderServiceSelector(doc);
  const engine = getElement<HTMLSelectElement>(doc, "bilingualreader-engine");
  if (engine) engine.value = getEngine();
  onPreferenceEdit(engine, (control) => {
    setEngine(control.value);
    updateBackendVisibility(doc);
    setFeedback(doc, "engine");
  });

  const fallbackEnabled = getElement<HTMLInputElement>(doc, "bilingualreader-fallback-enabled");
  if (fallbackEnabled) fallbackEnabled.checked = getFreeFallbackEnabled();
  onPreferenceEdit(fallbackEnabled, control => setFreeFallbackEnabled(control.checked));
  bindTextPreference(doc, "bilingualreader-fallback-order", getFreeFallbackOrder(), setFreeFallbackOrder);

  const native = getElement<HTMLSelectElement>(doc, "bilingualreader-native-backend");
  const refreshParserFields = () => {
    const docling = getElement<HTMLElement>(doc, "bilingualreader-docling-section");
    if (docling) docling.hidden = native?.value !== "docling";
    for (const provider of CLOUD_PROVIDERS) {
      const section = getElement<HTMLElement>(doc, "bilingualreader-cloud-" + provider + "-section");
      if (section) section.hidden = native?.value !== provider;
    }
  };
  if (native) native.value = getNativePDFBackend();
  onPreferenceEdit(native, ({ value }) => {
    setNativePDFBackend(value === "docling" || isCloudParser(value) ? value : "pdfjs");
    refreshParserFields();
  });
  refreshParserFields();
  for (const provider of CLOUD_PROVIDERS) {
    bindTextPreference(doc, "bilingualreader-cloud-" + provider + "-key",
      getCloudKey(provider), (value) => {
        const key = value.trim();
        if (key === getCloudKey(provider)) return;
        setCloudKey(provider, key);
        if (provider === "mineru") {
          setFeedback(doc, "mineru", key ? "Token 已自动保存 · 可点击验证" : "Token 已清除");
        }
      });
    bindTextPreference(doc, "bilingualreader-cloud-" + provider + "-model",
      getCloudModel(provider), (value) => {
        if (value.trim() === getCloudModel(provider)) return;
        setCloudModel(provider, value);
        if (provider === "mineru") setFeedback(doc, "mineru", "模型已自动保存 · 可点击验证");
      });
  }

  bindTextPreference(doc, "bilingualreader-docling-url", getDoclingEndpoint(), setDoclingEndpoint);
  bindTextPreference(doc, "bilingualreader-ollama-url", getOllamaURL(), (value) => {
    if (value !== getOllamaURL()) setFeedback(doc, "engine");
    setOllamaURL(value);
  });
  bindTextPreference(doc, "bilingualreader-ollama-model", getOllamaModel(), (value) => {
    if (value !== getOllamaModel()) setFeedback(doc, "engine");
    setOllamaModel(value);
  });

  const exportLayout = getElement<HTMLSelectElement>(doc, "bilingualreader-export-layout");
  if (exportLayout) exportLayout.value = getPDFExportLayout();
  onPreferenceEdit(exportLayout, ({ value }) => setPDFExportLayout(value));

  const allPages = getElement<HTMLInputElement>(doc, "bilingualreader-translate-all-pages");
  const nonReferences = getElement<HTMLInputElement>(doc, "bilingualreader-translate-non-references");
  const skipPages = getElement<HTMLInputElement>(doc, "bilingualreader-skip-last-pages");
  const updatePageRange = () => {
    const all = getTranslateAllPages();
    if (allPages) allPages.checked = all;
    if (nonReferences) nonReferences.checked = !all;
    if (skipPages) skipPages.disabled = all;
  };
  updatePageRange();
  for (const [input, all] of [[allPages, true], [nonReferences, false]] as const) {
    onPreferenceEdit(input, ({ checked }) => {
      if (!checked) return;
      setTranslateAllPages(all);
      updatePageRange();
    }, false);
  }

  const numberPreferences = [
    ["skip-last-pages", () => getSkipLastPages() || DEFAULT_SKIP_LAST_PAGES, setSkipLastPages],
    ["cache-max-entries", getCacheMaxEntries, (count: number) => {
      if (getCacheMaxEntries() === count) return;
      setCacheMaxEntries(count);
      enforceTranslationCacheLimit();
      updateCacheStatus(doc);
    }],
    ["max-concurrent", getMaxConcurrent, setMaxConcurrent],
    ["request-gap", getRequestGapMs, setRequestGapMs],
    ["max-chars", getMaxCharsPerRequest, setMaxCharsPerRequest],
    ["max-batch-paragraphs", getMaxBatchParagraphs, setMaxBatchParagraphs],
    ["max-errors", getMaxConsecutiveErrors, setMaxConsecutiveErrors],
    ["request-timeout", getRequestTimeoutMs, setRequestTimeoutMs],
  ] as const;
  for (const [id, get, set] of numberPreferences) {
    const input = getElement<HTMLInputElement>(doc, "bilingualreader-" + id);
    if (input) input.value = String(get());
    onPreferenceEdit(input, (control) => {
      if (!control.validity.valid || !Number.isFinite(control.valueAsNumber)) {
        throw new Error(`请输入 ${control.min} 到 ${control.max} 之间的整数。`);
      }
      set(control.valueAsNumber);
    // Commit cache size after editing so intermediary digits cannot evict entries.
    }, id !== "cache-max-entries");
  }

  const checkpointEnabled = getElement<HTMLInputElement>(doc, "bilingualreader-checkpoint-enabled");
  if (checkpointEnabled) checkpointEnabled.checked = getCheckpointEnabled();
  onPreferenceEdit(checkpointEnabled, control => setCheckpointEnabled(control.checked));
  updateBackendVisibility(doc);
  updatePDFTranslateStatus(doc);
  updateCacheStatus(doc);
  registerExternalLink(doc, "bilingualreader-github-link", PROJECT_URL);
  registerExternalLink(doc, "bilingualreader-mineru-link",
    "https://mineru.net/apiManage/docs?openApplyModal=true");
  const dictionaryNote = getElement<HTMLElement>(doc, "bilingualreader-dictionary-note");
  if (dictionaryNote) {
    dictionaryNote.textContent = "词典类服务仅支持查词：" +
      DICTIONARY_ONLY_SERVICES.map((name) => name + "（不推荐）").join("、") + "。";
  }
  if (getCloudKey("mineru")) setFeedback(doc, "mineru", "已保存 Token · 可点击验证");

  getElement<HTMLButtonElement>(doc, "bilingualreader-test-mineru")?.addEventListener(
    "click", () => { void testMinerU(doc); },
  );

  getElement<HTMLButtonElement>(doc, "bilingualreader-test-service")?.addEventListener(
    "click",
    () => { void testSelectedService(doc); },
  );

  getElement<HTMLButtonElement>(doc, "bilingualreader-test-docling")?.addEventListener(
    "click",
    () => { void testDocling(doc); },
  );

  getElement<HTMLButtonElement>(doc, "bilingualreader-test-ollama")?.addEventListener(
    "click",
    () => {
      void testOllama(doc);
    },
  );

  getElement<HTMLButtonElement>(doc, "bilingualreader-clear-cache")?.addEventListener(
    "click",
    () => {
      try { clearCache(doc); } catch (_) { setStatus(doc, "部分本地记录清除失败，请重试。"); }
    },
  );
}
