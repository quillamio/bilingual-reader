import { cleanupBilingualReader, renderBilingualToolbarButtons } from "./bilingualReader";
import { cleanupReaderUI, renderReaderExportButton } from "./readerUI";

const PLUGIN_ID = "bilingual-reader@zotero.local";
const STARTUP_RECONCILE_DELAYS_MS = [250, 1000, 3000];

type ToolbarRenderer = (event: any) => void;

const toolbarRenderers: ToolbarRenderer[] = [
  renderBilingualToolbarButtons,
  renderReaderExportButton,
];

let registered = false;
let reconcileTimeouts: ReturnType<typeof setTimeout>[] = [];

function applyFallbackSectionLayout(section: HTMLElement): void {
  // Never inherit Zotero's generic ".section" layout rules here. Some Zotero
  // 10 builds/themes apply a vertical layout to that class, which can stack our
  // toolbar buttons. Keep the fallback container fully namespaced and explicit.
  section.classList.remove("section");
  section.classList.add("bilingual-reader-toolbar-section");
  section.style.display = "inline-flex";
  section.style.flexDirection = "row";
  section.style.alignItems = "center";
  section.style.flexWrap = "nowrap";
  section.style.flexShrink = "0";
  section.style.whiteSpace = "nowrap";
  section.style.gap = "0";
  section.style.overflow = "visible";
}

function getOrCreateFallbackSection(doc: Document, container: Element): HTMLElement {
  let section = container.querySelector(
    ".bilingual-reader-toolbar-section",
  ) as HTMLElement | null;

  if (!section) {
    section = doc.createElement("div");
    container.append(section);
  }

  applyFallbackSectionLayout(section);
  return section;
}

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
          getOrCreateFallbackSection(doc, container).append(...elements);
        },
      });
    } catch (error) {
      // A reader can close or replace its iframe while being inspected.
      Zotero.logError(error as Error);
    }
  }
}

function clearStartupReconcileTimeouts(): void {
  for (const timeout of reconcileTimeouts) clearTimeout(timeout);
  reconcileTimeouts = [];
}

function scheduleStartupReconcile(): void {
  clearStartupReconcileTimeouts();

  // One immediate pass handles already-open readers. A few bounded retries
  // cover restored/slow readers without keeping a permanent polling loop alive.
  reconcileReaderToolbars();
  reconcileTimeouts = STARTUP_RECONCILE_DELAYS_MS.map((delay) =>
    setTimeout(() => {
      if (registered) reconcileReaderToolbars();
    }, delay),
  );
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
  scheduleStartupReconcile();
}

export function unregisterReaderToolbar(): void {
  clearStartupReconcileTimeouts();

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
