import { isManagedService, getServiceRevision, getServiceDefinition } from "./serviceCatalog";
import { DEFAULT_FALLBACK_ORDER, normalizeFallbackOrder, providerGroup } from "./translationRouter";

const BASE = "extensions.zotero.bilingualreader";

export type TranslationEngine = string;
export type PDFExportLayout = "stacked" | "side-by-side";
export type PDFSideRenderer = "auto" | "direct" | "browser";

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_MODEL = "gpt-oss:20b";
export const DEFAULT_REQUEST_GAP_MS = 250;
export const DEFAULT_MAX_CONCURRENT = 2;
export const DEFAULT_MAX_CHARS_PER_REQUEST = 2800;
export const DEFAULT_MAX_BATCH_PARAGRAPHS = 6;
export const DEFAULT_MAX_CONSECUTIVE_ERRORS = 3;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60000;
export const DEFAULT_SKIP_LAST_PAGES = 1;
const DEFAULT_CACHE_MAX_ENTRIES = 1500;
const MAX_INTEGER_PREF = 2147483647;

const DEFAULT_ENGINE = "pdftranslate";
const ENGINE_PREF = `${BASE}.engine`;
const OLLAMA_URL_PREF = `${BASE}.ollama.url`;
const OLLAMA_MODEL_PREF = `${BASE}.ollama.model`;
const REQUEST_GAP_PREF = `${BASE}.requestGapMs`;
const MAX_CONCURRENT_PREF = `${BASE}.maxConcurrent`;
const MAX_CHARS_PREF = `${BASE}.maxCharsPerRequest`;
const MAX_BATCH_PARAGRAPHS_PREF = `${BASE}.maxBatchParagraphs`;
const MAX_ERRORS_PREF = `${BASE}.maxConsecutiveErrors`;
const REQUEST_TIMEOUT_PREF = `${BASE}.requestTimeoutMs`;
const SKIP_LAST_PAGES_PREF = `${BASE}.skipLastPages`;
const TRANSLATE_ALL_PAGES_PREF = `${BASE}.translateAllPages`;
const CACHE_MAX_ENTRIES_PREF = `${BASE}.cacheMaxEntries`;
const EXPORT_LAYOUT_PREF = `${BASE}.export.layout`;

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
  const value = getStringPref(ENGINE_PREF, DEFAULT_ENGINE);
  return value === "ollama" || value === DEFAULT_ENGINE || isManagedService(value)
    ? value
    : DEFAULT_ENGINE;
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

export function getTranslateAllPages(): boolean {
  // A legacy skipLastPages=0 includes every page but still skips references.
  return Zotero.Prefs.get(TRANSLATE_ALL_PAGES_PREF, true) === true;
}

export function setTranslateAllPages(enabled: boolean): void {
  if (!enabled && getSkipLastPages() === 0) setSkipLastPages(DEFAULT_SKIP_LAST_PAGES);
  Zotero.Prefs.set(TRANSLATE_ALL_PAGES_PREF, enabled, true);
}

export function getTranslationPageCount(totalPages: number): number {
  if (getTranslateAllPages()) return totalPages;
  return Math.max(Math.min(1, totalPages), totalPages - getSkipLastPages());
}

export function getCacheMaxEntries(): number {
  return getNumberPref(CACHE_MAX_ENTRIES_PREF, DEFAULT_CACHE_MAX_ENTRIES, 0, MAX_INTEGER_PREF);
}

export function setCacheMaxEntries(count: number): void {
  setNumberPref(CACHE_MAX_ENTRIES_PREF, count, 0, MAX_INTEGER_PREF);
}

export function getPDFExportLayout(): PDFExportLayout {
  return getStringPref(EXPORT_LAYOUT_PREF, "stacked") === "side-by-side" ? "side-by-side" : "stacked";
}

export function setPDFExportLayout(layout: string): void {
  setStringPref(EXPORT_LAYOUT_PREF, layout === "side-by-side" ? layout : "stacked");
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

export function getCacheEngineTag(
  actualPDFTranslateService?: string,
  requestedEngine: TranslationEngine = getEngine(),
): string {
  const engine = requestedEngine;
  if (engine === "ollama") {
    return `ollama:${getOllamaURL()}:${getOllamaModel()}`;
  }
  if (engine === "google" || engine === "googleapi" || engine === "bing") {
    return `builtin:${engine}:en:zh-CN`;
  }
  if (isManagedService(engine)) {
    return `native:${engine}:revision:${getServiceRevision(engine)}:en:zh-CN`;
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


const FALLBACK_ENABLED_PREF = BASE + ".fallback.enabled";
const FALLBACK_ORDER_PREF = BASE + ".fallback.order";

export function getFreeFallbackEnabled(): boolean {
  return (Zotero.Prefs as any).get(FALLBACK_ENABLED_PREF, true) === true;
}
export function setFreeFallbackEnabled(value: boolean): void {
  (Zotero.Prefs as any).set(FALLBACK_ENABLED_PREF, value, true);
}
export function getFreeFallbackOrder(): string {
  const raw = (Zotero.Prefs as any).get(FALLBACK_ORDER_PREF, true);
  return normalizeFallbackOrder(typeof raw === "string" ? raw : DEFAULT_FALLBACK_ORDER).join(",");
}
export function setFreeFallbackOrder(value: string): void {
  setStringPref(FALLBACK_ORDER_PREF, normalizeFallbackOrder(value).join(","));
}
export function getRouteEngines(primary: string): string[] {
  if (!getFreeFallbackEnabled() || (primary !== "pdftranslate" && getServiceDefinition(primary)?.group !== "free")) return [primary];
  return [...new Set([primary, ...normalizeFallbackOrder(getFreeFallbackOrder())])];
}
export function getRouteProviderGroup(engine: string): string {
  if (engine !== "pdftranslate") return providerGroup(engine);
  const actual = getResolvedPDFTranslateService();
  return actual && getServiceDefinition(actual) ? providerGroup(actual) : "pdftranslate";
}
export function getMixedRouteCacheTag(primary: string): string {
  return "mixed-route:" + JSON.stringify(getRouteEngines(primary).map(engine => getCacheEngineTag(undefined, engine)));
}
export function getRoutedCacheTags(primary: string): string[] {
  const engines = getRouteEngines(primary);
  const tags = engines.map(engine => getCacheEngineTag(undefined, engine));
  return engines.length > 1 ? [...tags, getMixedRouteCacheTag(primary)] : tags;
}

export function getPDFSideRenderer(): PDFSideRenderer {
  const value = getStringPref(BASE + ".export.sideRenderer", "auto");
  return value === "browser" || value === "direct" ? value : "auto";
}
export function setPDFSideRenderer(value: string): void {
  setStringPref(BASE + ".export.sideRenderer", value === "browser" || value === "direct" ? value : "auto");
}

export function getPDFExportProvider(): "local" | "belindoc" { return getStringPref(BASE+".export.provider","local")==="belindoc"?"belindoc":"local"; }
export function setPDFExportProvider(value:string):void { setStringPref(BASE+".export.provider",value==="belindoc"?"belindoc":"local"); }
export function getBelinKey():string { return getStringPref(BASE+".belindoc.key",""); }
export function setBelinKey(value:string):void { setStringPref(BASE+".belindoc.key",value.trim()); }
export function getBelinModel():string { return getStringPref(BASE+".belindoc.model",""); }
export function setBelinModel(value:string):void { setStringPref(BASE+".belindoc.model",value.trim()); }
export function getBelinOCR(): "auto"|"off"|"on" { const v=getStringPref(BASE+".belindoc.ocr","auto"); return v==="on"||v==="off"?v:"auto"; }
export function setBelinOCR(v:string):void { setStringPref(BASE+".belindoc.ocr",v==="on"||v==="off"?v:"auto"); }
export function getBelinLayout(): "stacked"|"side-by-side"|"translation" { const v=getStringPref(BASE+".belindoc.layout","side-by-side");return v==="stacked"||v==="translation"?v:"side-by-side"; }
export function setBelinLayout(v:string):void { setStringPref(BASE+".belindoc.layout",v==="stacked"||v==="translation"?v:"side-by-side"); }
