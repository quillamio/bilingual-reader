import { initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import {
  registerBilingualReader,
  unregisterBilingualReader,
} from "./bilingualReader";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();
  registerBilingualReader();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
}

async function onMainWindowLoad(_win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();
}

async function onMainWindowUnload(_win: Window): Promise<void> {
  // Reader event listeners are registered globally and removed on shutdown.
}

function onShutdown(): void {
  unregisterBilingualReader();
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

async function onPrefsEvent(_type: string, _data: { [key: string]: any }) {
  // Reserved for a future settings page.
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
