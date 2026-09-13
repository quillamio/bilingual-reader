interface LayoutObserver {
  refresh: () => void;
  dispose: () => void;
}

const layouts = new WeakMap<Document, LayoutObserver>();
const activeLayouts = new Set<LayoutObserver>();

/** Keep Zotero's native annotation ranges/geometry in sync with inserted text. */
export function observeReadingLayout(view: any, doc: Document): void {
  if (layouts.has(doc)) return;
  const root = doc.querySelector("#sdt-content");
  const win = doc.defaultView;
  if (!root || !win) return;

  let disposed = false;
  let frame: number | undefined;
  const refresh = () => {
    if (disposed) return;
    try {
      if (view?._destroyed || !root.isConnected) return;
      // This is the same path Zotero uses after a reading-mode resize. It
      // invalidates both annotation range and page-rectangle caches, then
      // synchronously redraws highlights and repositions their popups.
      if (typeof view?._handleViewUpdate === "function") {
        view._handleViewUpdate(true);
      } else {
        win.dispatchEvent(new (win as any).Event("resize"));
      }
    } catch (error) {
      Zotero.logError(error as Error);
    }
  };
  const schedule = () => {
    if (disposed || frame !== undefined) return;
    frame = win.requestAnimationFrame(() => {
      frame = undefined;
      refresh();
    });
  };

  // Observe only the content, not Zotero's annotation overlay: observing the
  // overlay would trigger another refresh every time highlights are rendered.
  // Use a privileged DOM constructor. The SDT window is an unwrapped content
  // window; its WebIDL option conversion cannot read a plugin-owned dictionary.
  const observerWindow = Zotero.getMainWindow() as any;
  const mutations = new observerWindow.MutationObserver(schedule) as MutationObserver;
  mutations.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["style", "class", "hidden"],
  });
  const resizes: ResizeObserver | undefined = observerWindow.ResizeObserver
    ? new observerWindow.ResizeObserver(schedule)
    : undefined;
  resizes?.observe(root);
  root.addEventListener("load", schedule, true);
  doc.fonts?.addEventListener("loadingdone", schedule);

  const observer: LayoutObserver = {
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      layouts.delete(doc);
      activeLayouts.delete(observer);
      try {
        mutations.disconnect();
        resizes?.disconnect();
        if (frame !== undefined) win.cancelAnimationFrame(frame);
        root.removeEventListener("load", schedule, true);
        doc.fonts?.removeEventListener("loadingdone", schedule);
        win.removeEventListener("pagehide", observer.dispose);
      } catch (_) {
        // Zotero may already have destroyed this iframe during shutdown.
      }
    },
  };
  layouts.set(doc, observer);
  activeLayouts.add(observer);
  win.addEventListener("pagehide", observer.dispose);
  // Content can appear just before the SDT view finishes initialization.
  void Promise.resolve(view?.initializedPromise).then(schedule, (error) => {
    if (!disposed) Zotero.logError(error as Error);
  });
  schedule();
}

/** Call after removing translations so the original layout is drawn once. */
export function cleanupReadingLayout(doc: Document): void {
  const observer = layouts.get(doc);
  if (!observer) return;
  observer.refresh();
  observer.dispose();
}

export function cleanupAllReadingLayouts(): void {
  for (const observer of activeLayouts) observer.dispose();
}
