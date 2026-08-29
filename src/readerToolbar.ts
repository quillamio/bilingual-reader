import { cleanupBilingualReader, renderBilingualToolbarButtons } from "./bilingualReader";
import { cleanupReaderUI, renderReaderExportButton } from "./readerUI";

const PLUGIN_ID = "bilingual-reader@zotero.local";

type ToolbarRenderer = (event: any) => void;

const toolbarRenderers: ToolbarRenderer[] = [
  renderBilingualToolbarButtons,
  renderReaderExportButton,
];

let registered = false;

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
}

export function unregisterReaderToolbar(): void {
  if (registered) {
    Zotero.Reader.unregisterEventListener("renderToolbar", renderReaderToolbar);
    registered = false;
  }

  const readers = ((Zotero.Reader as any)._readers || []) as any[];
  for (const reader of readers) cleanupReader(reader);
}
