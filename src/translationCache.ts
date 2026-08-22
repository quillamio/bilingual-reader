const BASE = "extensions.zotero.bilingualreader";
const TARGET_LANG = "zh-CN";
const CACHE_PREFIX = `${BASE}.cache.v4.`;
const LEGACY_CACHE_PREFIX = `${BASE}.cache.v3.`;
const CACHE_INDEX_KEY = `${CACHE_PREFIX}index`;

// Long translations do not belong in preferences indefinitely. Keep the
// existing lightweight storage format, but cap it to a predictable footprint.
const MAX_CACHE_ENTRIES = 1500;
const MAX_CACHE_CHARS = 6_000_000;

interface CacheIndexEntry {
  key: string;
  chars: number;
  lastAccess: number;
}

export interface TranslationCacheStats {
  entries: number;
  chars: number;
}

let cacheIndex: CacheIndexEntry[] | null = null;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

function prefGet(key: string): unknown {
  return (Zotero.Prefs as any).get(key, true);
}

function prefSet(key: string, value: string): void {
  (Zotero.Prefs as any).set(key, value, true);
}

function prefClear(key: string): void {
  try {
    (Zotero.Prefs as any).clear(key, true);
  } catch (_) {
    // The preference may already have been removed.
  }
}

function hash(text: string): string {
  let result = 2166136261;
  for (let i = 0; i < text.length; i++) {
    result = Math.imul(result ^ text.charCodeAt(i), 16777619);
  }
  return (result >>> 0).toString(16);
}

function safeItemKey(itemKey: string): string {
  return itemKey.replace(/[^a-z0-9_-]/giu, "_").slice(0, 64) || "reader";
}

function cacheKey(itemKey: string, sourceText: string, engineTag: string): string {
  return `${CACHE_PREFIX}${hash(engineTag)}.${safeItemKey(itemKey)}.${sourceText.length}.${hash(
    sourceText,
  )}.${TARGET_LANG}`;
}

function legacyCacheKey(itemKey: string, sourceText: string, engineTag: string): string {
  return `${LEGACY_CACHE_PREFIX}${hash(engineTag)}.${itemKey}.${hash(sourceText)}.${TARGET_LANG}`;
}

function getCacheIndex(): CacheIndexEntry[] {
  if (cacheIndex) return cacheIndex;

  const raw = prefGet(CACHE_INDEX_KEY);
  if (typeof raw !== "string" || !raw) {
    cacheIndex = [];
    return cacheIndex;
  }

  try {
    const parsed = JSON.parse(raw);
    cacheIndex = Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is CacheIndexEntry =>
            typeof entry?.key === "string" &&
            entry.key.startsWith(CACHE_PREFIX) &&
            entry.key !== CACHE_INDEX_KEY &&
            Number.isFinite(entry?.chars) &&
            Number.isFinite(entry?.lastAccess),
        )
      : [];
  } catch (_) {
    cacheIndex = [];
  }
  return cacheIndex;
}

function persistCacheIndex(): void {
  if (persistTimer !== undefined) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  prefSet(CACHE_INDEX_KEY, JSON.stringify(getCacheIndex()));
}

function schedulePersistCacheIndex(): void {
  if (persistTimer !== undefined) return;
  persistTimer = setTimeout(() => persistCacheIndex(), 500);
}

function removeIndexEntry(key: string): void {
  const index = getCacheIndex();
  const position = index.findIndex((entry) => entry.key === key);
  if (position >= 0) index.splice(position, 1);
}

function touchCacheEntry(key: string, chars: number): void {
  const index = getCacheIndex();
  const existing = index.find((entry) => entry.key === key);
  if (existing) {
    existing.chars = chars;
    existing.lastAccess = Date.now();
    return;
  }
  index.push({ key, chars, lastAccess: Date.now() });
}

function pruneCache(): void {
  const index = getCacheIndex();
  let totalChars = index.reduce((sum, entry) => sum + Math.max(0, entry.chars), 0);
  if (index.length <= MAX_CACHE_ENTRIES && totalChars <= MAX_CACHE_CHARS) return;

  index.sort((a, b) => a.lastAccess - b.lastAccess);
  while (index.length > MAX_CACHE_ENTRIES || totalChars > MAX_CACHE_CHARS) {
    const oldest = index.shift();
    if (!oldest) break;
    totalChars -= Math.max(0, oldest.chars);
    prefClear(oldest.key);
  }
}

export function loadCachedTranslation(
  itemKey: string,
  sourceText: string,
  engineTag: string,
  isFailureText: (text: string) => boolean,
): string | undefined {
  const key = cacheKey(itemKey, sourceText, engineTag);
  let value = prefGet(key);

  // Lazily migrate successful v0.1.3 entries. This avoids a costly rewrite of
  // every old preference at startup while preserving translations in use.
  if (typeof value !== "string" || !value.trim()) {
    const legacyKey = legacyCacheKey(itemKey, sourceText, engineTag);
    const legacyValue = prefGet(legacyKey);
    if (typeof legacyValue === "string" && legacyValue.trim() && !isFailureText(legacyValue)) {
      value = legacyValue;
      saveCachedTranslation(itemKey, sourceText, legacyValue, engineTag, isFailureText);
      prefClear(legacyKey);
    }
  }

  if (typeof value !== "string" || !value.trim()) return undefined;
  if (isFailureText(value)) {
    prefClear(key);
    removeIndexEntry(key);
    schedulePersistCacheIndex();
    return undefined;
  }

  touchCacheEntry(key, value.length);
  return value;
}

export function saveCachedTranslation(
  itemKey: string,
  sourceText: string,
  translation: string,
  engineTag: string,
  isFailureText: (text: string) => boolean,
): void {
  if (isFailureText(translation)) return;

  const key = cacheKey(itemKey, sourceText, engineTag);
  prefSet(key, translation);
  touchCacheEntry(key, translation.length);
  pruneCache();
  schedulePersistCacheIndex();
}

export function flushTranslationCacheIndex(): void {
  if (cacheIndex) persistCacheIndex();
}

export function getTranslationCacheStats(): TranslationCacheStats {
  const index = getCacheIndex();
  return {
    entries: index.length,
    chars: index.reduce((sum, entry) => sum + Math.max(0, entry.chars), 0),
  };
}

export function clearTranslationCache(): TranslationCacheStats {
  const rootBranch = (Zotero.Prefs as any).rootBranch;
  const physicalPrefixes = [`${BASE}.cache.`, `extensions.zotero.${BASE}.cache.`];
  let removed = 0;
  let chars = 0;

  if (rootBranch?.getChildList) {
    for (const prefix of physicalPrefixes) {
      const keys = rootBranch.getChildList(prefix, {}) || [];
      for (const key of keys) {
        try {
          const value = rootBranch.getStringPref?.(key) || "";
          chars += String(value).length;
          rootBranch.clearUserPref(key);
          removed += 1;
        } catch (_) {
          // Continue clearing the remaining cache entries.
        }
      }
    }
  } else {
    for (const entry of getCacheIndex()) {
      chars += entry.chars;
      prefClear(entry.key);
      removed += 1;
    }
    prefClear(CACHE_INDEX_KEY);
  }

  if (persistTimer !== undefined) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  cacheIndex = [];
  return { entries: removed, chars };
}
