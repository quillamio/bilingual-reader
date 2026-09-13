import { cleanupBilingualReader, renderBilingualToolbarButtons } from "./bilingualReader";
import { cleanupReaderUI, renderReaderExportButton } from "./readerUI";

const PLUGIN_ID = "bilingual-reader@zotero.local";

type ToolbarRenderer = (event: any) => void;

const toolbarRenderers: ToolbarRenderer[] = [
  renderBilingualToolbarButtons,
  renderReaderExportButton,
];

let registered = false;
let reconcileTimer: ReturnType<typeof setInterval> | undefined;

/** Catch readers whose toolbar mounted before plugin installation/startup. */
export function reconcileReaderToolbars(): void {
  const readers = ((Zotero.Reader as any)._readers || []) as any[];
  for (const reader of readers) {
    try {
      if (reader.type !== "pdf" || reader._isUninitialized) continue;
      const doc = reader._iframeWindow?.document as Document | undefined;
      const container = doc?.querySelector(".toolbar .custom-sections");
      if (!doc || !container) continue;

      renderReaderToolbar({
        reader,
        doc,
        append: (...elements: HTMLElement[]) => {
          let section = container.querySelector(".bilingual-reader-toolbar-section");
          if (!section) {
            section = doc.createElement("div");
            section.className = "section bilingual-reader-toolbar-section";
            container.append(section);
          }
          section.append(...elements);
        },
      });
    } catch (error) {
      // A reader can close or replace its iframe while being inspected.
      Zotero.logError(error as Error);
    }
  }
}

/**
 * Render every Bilingual Reader control from one Zotero Reader listener.
 *
 * Zotero dispatches Reader listeners synchronously without isolating exceptions.
 * Keeping our controls in one listener removes ordering dependencies, while the
 * per-control guard prevents one optional control from hiding the other icons.
 */
export function renderReaderToolbar(event: any): void {
  for (const render of toolbarRenderers) {
    try {
      render(event);
    } catch (error) {
      Zotero.logError(error as Error);
    }
  }
}

function cleanupReader(reader: any): void {
  for (const cleanup of [cleanupReaderUI, cleanupBilingualReader]) {
    try {
      cleanup(reader);
    } catch (error) {
      Zotero.logError(error as Error);
    }
  }
}

export function registerReaderToolbar(): void {
  if (registered) return;
  Zotero.Reader.registerEventListener("renderToolbar", renderReaderToolbar, PLUGIN_ID);
  registered = true;
  reconcileReaderToolbars();
  // Reconcile newly restored/slow readers and remounted toolbars as well. A
  // single process timer avoids a timeout race and per-reader observer leaks.
  reconcileTimer = setInterval(reconcileReaderToolbars, 1000);
}

export function unregisterReaderToolbar(): void {
  if (reconcileTimer !== undefined) {
    clearInterval(reconcileTimer);
    reconcileTimer = undefined;
  }
  if (registered) {
    Zotero.Reader.unregisterEventListener("renderToolbar", renderReaderToolbar);
    registered = false;
  }

  const readers = ((Zotero.Reader as any)._readers || []) as any[];
  for (const reader of readers) {
    cleanupReader(reader);
    try {
      reader._iframeWindow?.document?.querySelector(".bilingual-reader-toolbar-section")?.remove();
    } catch (_) {
      // The reader may already have closed.
    }
  }
}
