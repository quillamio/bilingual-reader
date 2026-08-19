const BASE = "extensions.zotero.bilingualreader";

export type TranslationEngine = "pdftranslate" | "ollama";

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_MODEL = "gpt-oss:20b";
export const DEFAULT_REQUEST_GAP_MS = 650;
export const DEFAULT_MAX_CONSECUTIVE_ERRORS = 3;

const ENGINE_PREF = `${BASE}.engine`;
const PDFTRANSLATE_SERVICE_PREF = `${BASE}.pdftranslate.service`;
const OLLAMA_URL_PREF = `${BASE}.ollama.url`;
const OLLAMA_MODEL_PREF = `${BASE}.ollama.model`;
const REQUEST_GAP_PREF = `${BASE}.requestGapMs`;
const MAX_ERRORS_PREF = `${BASE}.maxConsecutiveErrors`;

function getStringPref(key: string, fallback: string): string {
  const value = (Zotero.Prefs as any).get(key);
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function setStringPref(key: string, value: string): void {
  (Zotero.Prefs as any).set(key, value);
}

function getNumberPref(key: string, fallback: number, min: number, max: number): number {
  const raw = (Zotero.Prefs as any).get(key);
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function setNumberPref(key: string, value: number, min: number, max: number): void {
  const normalized = Math.min(max, Math.max(min, Math.round(value)));
  (Zotero.Prefs as any).set(key, normalized);
}

export function getEngine(): TranslationEngine {
  return getStringPref(ENGINE_PREF, "pdftranslate") === "ollama" ? "ollama" : "pdftranslate";
}

export function setEngine(engine: TranslationEngine): void {
  setStringPref(ENGINE_PREF, engine);
}

export function getPDFTranslateService(): string {
  const value = (Zotero.Prefs as any).get(PDFTRANSLATE_SERVICE_PREF);
  return typeof value === "string" ? value.trim() : "";
}

export function setPDFTranslateService(service: string): void {
  setStringPref(PDFTRANSLATE_SERVICE_PREF, service.trim());
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

export function getRequestGapMs(): number {
  return getNumberPref(REQUEST_GAP_PREF, DEFAULT_REQUEST_GAP_MS, 0, 10000);
}

export function setRequestGapMs(value: number): void {
  setNumberPref(REQUEST_GAP_PREF, value, 0, 10000);
}

export function getMaxConsecutiveErrors(): number {
  return getNumberPref(MAX_ERRORS_PREF, DEFAULT_MAX_CONSECUTIVE_ERRORS, 1, 20);
}

export function setMaxConsecutiveErrors(value: number): void {
  setNumberPref(MAX_ERRORS_PREF, value, 1, 20);
}

export function getCacheEngineTag(): string {
  if (getEngine() === "ollama") {
    return `ollama:${getOllamaURL()}:${getOllamaModel()}`;
  }
  return `pdftranslate:${getPDFTranslateService() || "default"}`;
}
