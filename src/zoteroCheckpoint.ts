import { TranslationCheckpoint, checkpointIdentity, type CheckpointEntry } from "./translationCheckpoint";
import { getMixedRouteCacheTag } from "./settings";

const PREFIX = "extensions.zotero.bilingualreader.checkpoint.v1.";
const ENABLED = "extensions.zotero.bilingualreader.checkpoint.enabled";
const MAX_DOCUMENTS = 32;
let clearGeneration = 0;
export function getCheckpointEnabled(): boolean {
  return (Zotero.Prefs as any).get(ENABLED, true) !== false;
}
export function setCheckpointEnabled(enabled: boolean): void {
  (Zotero.Prefs as any).set(ENABLED, enabled, true);
  if (!enabled) clearGeneration++;
}
function keys(): string[] {
  const branch = (Zotero.Prefs as any).rootBranch;
  if (!branch?.getChildList) throw new Error("无法访问断点记录索引。");
  return branch.getChildList(PREFIX, {}) || [];
}
export function clearTranslationCheckpoints(): number {
  clearGeneration++;
  const branch = (Zotero.Prefs as any).rootBranch;
  let removed = 0;
  for (const key of keys()) {
    branch.clearUserPref(key);
    removed++;
  }
  return removed;
}
export function getCheckpointDocumentCount(): number {
  try { return keys().length; } catch (_) { return 0; }
}
export function openTranslationCheckpoint(itemID: number, itemKey: string, engine: string) {
  const item = Zotero.Items.get(itemID);
  const identity = checkpointIdentity(Number(item?.libraryID || 0), String(item?.key || itemKey), itemID);
  const generation = clearGeneration;
  let warning = "";
  const available = () => getCheckpointEnabled() && generation === clearGeneration;
  const store = new TranslationCheckpoint({
    read(key) {
      const value = (Zotero.Prefs as any).get(PREFIX + key, true);
      return typeof value === "string" ? value : undefined;
    },
    write(key, value) {
      if (!available()) return;
      const full = PREFIX + key;
      if (!(Zotero.Prefs as any).get(full, true) && keys().length >= MAX_DOCUMENTS) {
        throw new Error("断点记录附件数已达上限。");
      }
      (Zotero.Prefs as any).set(full, value, true);
    },
  }, identity, "quality-v1:" + getMixedRouteCacheTag(engine));
  function warn() {
    if (warning) return;
    warning = "本地断点记录不可写或已达容量上限，本次翻译仍可继续，但部分新进度可能无法在重启后恢复。";
    Zotero.logError(new Error(warning));
  }
  return {
    get(source: string, valid: (text: string) => boolean): CheckpointEntry | undefined {
      if (!available()) return undefined;
      try { return store.get(source, valid); } catch (_) { warn(); return undefined; }
    },
    record(source: string, result?: { text: string; tag: string }): void {
      if (!available()) return;
      try { store.record(source, result); } catch (_) { warn(); }
    },
    warning: () => warning,
  };
}
export type ZoteroCheckpoint = ReturnType<typeof openTranslationCheckpoint>;
