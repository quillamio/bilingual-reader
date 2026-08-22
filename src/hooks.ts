import { initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import { registerBilingualReader, unregisterBilingualReader } from "./bilingualReader";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { migrateLegacyPreferences } from "./settings";
import { flushTranslationCacheIndex } from "./translationCache";

async function registerPreferencesPane(): Promise<void> {
  await Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    id: "bilingual-reader-preferences",
    src: "content/preferences.xhtml",
    label: "中英对照",
  });
}

async function onStartup() {
  await Promise.all([Zotero.initializationPromise, Zotero.unlockPromise, Zotero.uiReadyPromise]);

  migrateLegacyPreferences();
  initLocale();
  await registerPreferencesPane();
  registerBilingualReader();

  await Promise.all(Zotero.getMainWindows().map((win) => onMainWindowLoad(win)));

  addon.data.initialized = true;
}

async function onMainWindowLoad(_win: _ZoteroTypes.MainWindow): Promise<void> {
  // The toolkit is process-scoped. Replacing it for every main window would
  // orphan registrations owned by the previous instance.
  addon.data.ztoolkit ||= createZToolkit();
}

async function onMainWindowUnload(_win: Window): Promise<void> {
  // Reader event listeners are registered globally and removed on shutdown.
}

function onShutdown(): void {
  unregisterBilingualReader();
  flushTranslationCacheIndex();
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onNotify(
  _event: string,
  _type: string,
  _ids: Array<string | number>,
  _extraData: { [key: string]: any },
) {
  // Reserved for future Zotero notifier integration.
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  if (type === "load" && data.window) {
    await registerPrefsScripts(data.window as Window);
  }
}

function onShortcuts(_type: string) {
  // Reserved for future keyboard shortcuts.
}

function onDialogEvents(_type: string) {
  // Reserved for future dialogs.
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};
