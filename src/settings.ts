import { normalizeChatCompletionsEndpoint } from "./translationPipeline";

const BASE = "extensions.zotero.bilingualreader";

export type TranslationEngine = "pdftranslate" | "ollama" | "openai";

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_MODEL = "gpt-oss:20b";
export const DEFAULT_OPENAI_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
export const DEFAULT_OPENAI_MODEL = "glm-4.7-flash";
export const DEFAULT_OPENAI_TEMPERATURE = 0.2;
export const DEFAULT_OPENAI_PROMPT = `你是学术论文翻译专家。把用户提供的英文段落准确翻译为简体中文。

要求：
1. 只输出译文，不要解释、总结或添加原文没有的内容。
2. 保持学术语体，术语使用领域通行译法并前后一致。
3. 原样保留数字、单位、公式、变量、基因/蛋白/药物名称、文献引用和图表编号。
4. 若原文含 [[BRSEG_0000]] 这类分段标记，必须逐字保留并保持顺序，不得翻译、删除或合并段落。
5. 被标记分隔的段落逐段翻译，输出顺序与输入一致。`;
export const DEFAULT_REQUEST_GAP_MS = 250;
export const DEFAULT_MAX_CONCURRENT = 2;
export const DEFAULT_MAX_CHARS_PER_REQUEST = 2800;
export const DEFAULT_MAX_BATCH_PARAGRAPHS = 6;
export const DEFAULT_MAX_CONSECUTIVE_ERRORS = 3;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60000;
export const DEFAULT_SKIP_LAST_PAGES = 1;

const ENGINE_PREF = `${BASE}.engine`;
const OLLAMA_URL_PREF = `${BASE}.ollama.url`;
const OLLAMA_MODEL_PREF = `${BASE}.ollama.model`;
const OPENAI_ENDPOINT_PREF = `${BASE}.openai.endpoint`;
const OPENAI_MODEL_PREF = `${BASE}.openai.model`;
const OPENAI_API_KEY_PREF = `${BASE}.openai.apiKey`;
const OPENAI_PROMPT_PREF = `${BASE}.openai.prompt`;
const OPENAI_TEMPERATURE_PREF = `${BASE}.openai.temperature`;
const FIGURE_BACKFILL_PREF = `${BASE}.figureBackfill`;
const REQUEST_GAP_PREF = `${BASE}.requestGapMs`;
const MAX_CONCURRENT_PREF = `${BASE}.maxConcurrent`;
const MAX_CHARS_PREF = `${BASE}.maxCharsPerRequest`;
const MAX_BATCH_PARAGRAPHS_PREF = `${BASE}.maxBatchParagraphs`;
const MAX_ERRORS_PREF = `${BASE}.maxConsecutiveErrors`;
const REQUEST_TIMEOUT_PREF = `${BASE}.requestTimeoutMs`;
const SKIP_LAST_PAGES_PREF = `${BASE}.skipLastPages`;

function getStringPref(key: string, fallback: string): string {
  const value = (Zotero.Prefs as any).get(key, true);
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function setStringPref(key: string, value: string): void {
  (Zotero.Prefs as any).set(key, value, true);
}

function getNumberPref(key: string, fallback: number, min: number, max: number): number {
  const raw = (Zotero.Prefs as any).get(key, true);
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function setNumberPref(key: string, value: number, min: number, max: number): void {
  const normalized = Math.min(max, Math.max(min, Math.round(value)));
  (Zotero.Prefs as any).set(key, normalized, true);
}

export function getEngine(): TranslationEngine {
  const value = getStringPref(ENGINE_PREF, "pdftranslate");
  return value === "ollama" || value === "openai" ? value : "pdftranslate";
}

export function setEngine(engine: TranslationEngine): void {
  setStringPref(ENGINE_PREF, engine);
}

export function getOllamaURL(): string {
  return getStringPref(OLLAMA_URL_PREF, DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
}

export function setOllamaURL(url: string): void {
  setStringPref(OLLAMA_URL_PREF, url.trim().replace(/\/+$/, "") || DEFAULT_OLLAMA_URL);
}

export function getOllamaModel(): string {
  return getStringPref(OLLAMA_MODEL_PREF, DEFAULT_OLLAMA_MODEL);
}

export function setOllamaModel(model: string): void {
  setStringPref(OLLAMA_MODEL_PREF, model.trim() || DEFAULT_OLLAMA_MODEL);
}

function getRawStringPref(key: string, fallback: string): string {
  const value = (Zotero.Prefs as any).get(key, true);
  return typeof value === "string" ? value : fallback;
}

export function getOpenAIEndpoint(): string {
  return getStringPref(OPENAI_ENDPOINT_PREF, DEFAULT_OPENAI_ENDPOINT);
}

export function setOpenAIEndpoint(endpoint: string): void {
  setStringPref(
    OPENAI_ENDPOINT_PREF,
    normalizeChatCompletionsEndpoint(endpoint) || DEFAULT_OPENAI_ENDPOINT,
  );
}

export function getOpenAIModel(): string {
  return getStringPref(OPENAI_MODEL_PREF, DEFAULT_OPENAI_MODEL);
}

export function setOpenAIModel(model: string): void {
  setStringPref(OPENAI_MODEL_PREF, model.trim() || DEFAULT_OPENAI_MODEL);
}

export function getOpenAIApiKey(): string {
  return getRawStringPref(OPENAI_API_KEY_PREF, "").trim();
}

export function setOpenAIApiKey(apiKey: string): void {
  (Zotero.Prefs as any).set(OPENAI_API_KEY_PREF, apiKey.trim(), true);
}

export function getOpenAIPrompt(): string {
  return getRawStringPref(OPENAI_PROMPT_PREF, DEFAULT_OPENAI_PROMPT).trim() || DEFAULT_OPENAI_PROMPT;
}

export function setOpenAIPrompt(prompt: string): void {
  (Zotero.Prefs as any).set(
    OPENAI_PROMPT_PREF,
    prompt.trim() || DEFAULT_OPENAI_PROMPT,
    true,
  );
}

export function getOpenAITemperature(): number {
  const value = Number(getStringPref(OPENAI_TEMPERATURE_PREF, String(DEFAULT_OPENAI_TEMPERATURE)));
  if (!Number.isFinite(value)) return DEFAULT_OPENAI_TEMPERATURE;
  return Math.min(2, Math.max(0, value));
}

export function setOpenAITemperature(value: number): void {
  const normalized = Number.isFinite(value)
    ? Math.min(2, Math.max(0, value))
    : DEFAULT_OPENAI_TEMPERATURE;
  setStringPref(OPENAI_TEMPERATURE_PREF, String(normalized));
}

export function getRequestGapMs(): number {
  return getNumberPref(REQUEST_GAP_PREF, DEFAULT_REQUEST_GAP_MS, 0, 5000);
}

export function setRequestGapMs(value: number): void {
  setNumberPref(REQUEST_GAP_PREF, value, 0, 5000);
}

export function getMaxConcurrent(): number {
  return getNumberPref(MAX_CONCURRENT_PREF, DEFAULT_MAX_CONCURRENT, 1, 3);
}

export function setMaxConcurrent(value: number): void {
  setNumberPref(MAX_CONCURRENT_PREF, value, 1, 3);
}

export function getMaxCharsPerRequest(): number {
  return getNumberPref(MAX_CHARS_PREF, DEFAULT_MAX_CHARS_PER_REQUEST, 500, 8000);
}

export function setMaxCharsPerRequest(value: number): void {
  setNumberPref(MAX_CHARS_PREF, value, 500, 8000);
}

export function getMaxBatchParagraphs(): number {
  return getNumberPref(MAX_BATCH_PARAGRAPHS_PREF, DEFAULT_MAX_BATCH_PARAGRAPHS, 1, 12);
}

export function setMaxBatchParagraphs(value: number): void {
  setNumberPref(MAX_BATCH_PARAGRAPHS_PREF, value, 1, 12);
}

export function getMaxConsecutiveErrors(): number {
  return getNumberPref(MAX_ERRORS_PREF, DEFAULT_MAX_CONSECUTIVE_ERRORS, 1, 20);
}

export function setMaxConsecutiveErrors(value: number): void {
  setNumberPref(MAX_ERRORS_PREF, value, 1, 20);
}

export function getRequestTimeoutMs(): number {
  return getNumberPref(REQUEST_TIMEOUT_PREF, DEFAULT_REQUEST_TIMEOUT_MS, 5000, 300000);
}

export function setRequestTimeoutMs(value: number): void {
  setNumberPref(REQUEST_TIMEOUT_PREF, value, 5000, 300000);
}

export function getSkipLastPages(): number {
  return getNumberPref(SKIP_LAST_PAGES_PREF, DEFAULT_SKIP_LAST_PAGES, 0, 50);
}

export function setSkipLastPages(value: number): void {
  setNumberPref(SKIP_LAST_PAGES_PREF, value, 0, 50);
}

export function getFigureBackfillEnabled(): boolean {
  const value = (Zotero.Prefs as any).get(FIGURE_BACKFILL_PREF, true);
  return value !== false;
}

export function setFigureBackfillEnabled(enabled: boolean): void {
  (Zotero.Prefs as any).set(FIGURE_BACKFILL_PREF, !!enabled, true);
}

export function getResolvedPDFTranslateService(): string {
  try {
    const current = (Zotero.Prefs as any).get(
      "extensions.zotero.ZoteroPDFTranslate.translateSource",
      true,
    );
    return typeof current === "string" ? current.trim() : "";
  } catch (_) {
    return "";
  }
}

function hashTag(text: string): string {
  let result = 2166136261;
  for (let i = 0; i < text.length; i++) {
    result = Math.imul(result ^ text.charCodeAt(i), 16777619);
  }
  return (result >>> 0).toString(16);
}

export function getCacheEngineTag(actualPDFTranslateService?: string): string {
  const engine = getEngine();
  if (engine === "ollama") {
    return `ollama:${getOllamaURL()}:${getOllamaModel()}`;
  }
  if (engine === "openai") {
    return `openai:${normalizeChatCompletionsEndpoint(getOpenAIEndpoint())}:${getOpenAIModel()}:${hashTag(
      `${getOpenAIPrompt()}\u0000${getOpenAITemperature()}`,
    )}`;
  }
  return `pdftranslate:${
    actualPDFTranslateService || getResolvedPDFTranslateService() || "default"
  }`;
}

/**
 * v0.1.3 passed already-qualified keys without Zotero's `global` flag. Zotero
 * therefore stored them under `extensions.zotero.extensions.zotero...`.
 * Move that branch once so existing user settings and caches are not lost.
 */
export function migrateLegacyPreferences(): void {
  const rootBranch = (Zotero.Prefs as any).rootBranch;
  if (!rootBranch?.getChildList) return;

  const malformedPrefix = `extensions.zotero.${BASE}.`;
  const keys = rootBranch.getChildList(malformedPrefix, {}) || [];
  for (const malformedKey of keys) {
    const correctedKey = malformedKey.slice("extensions.zotero.".length);
    try {
      if (!rootBranch.prefHasUserValue(correctedKey)) {
        switch (rootBranch.getPrefType(malformedKey)) {
          case rootBranch.PREF_BOOL:
            rootBranch.setBoolPref(correctedKey, rootBranch.getBoolPref(malformedKey));
            break;
          case rootBranch.PREF_INT:
            rootBranch.setIntPref(correctedKey, rootBranch.getIntPref(malformedKey));
            break;
          case rootBranch.PREF_STRING:
            rootBranch.setStringPref(correctedKey, rootBranch.getStringPref(malformedKey));
            break;
          default:
            break;
        }
      }
      rootBranch.clearUserPref(malformedKey);
    } catch (error) {
      Zotero.logError(error as Error);
    }
  }
}
