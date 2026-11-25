import { renderPDFRegion } from "./pdfNativeRuntime";

const CROP_SELECTOR = "figure.sdt-source-crop[data-ref-path]";
const pending = new WeakMap<HTMLElement, Promise<void>>();
const attempted = new WeakSet<HTMLElement>();
const queues = new WeakMap<Document, Promise<void>>();

function sourceRegions(view: any, figure: HTMLElement): Map<number, number[]> {
  const path = figure.dataset.refPath || "";
  const regions = new Map<number, number[]>();
  if (!/^\d+(?:\.\d+)*$/u.test(path)) return regions;

  let block = view?.getData?.()?.structure || view?._structure;
  for (const part of path.split(".")) block = block?.content?.[Number(part)];
  for (const anchor of block?.anchor?.pageRects || []) {
    if (anchor?.length !== 5 || !Array.from(anchor).every(Number.isFinite)) continue;
    const [page, x1, y1, x2, y2] = anchor;
    if (!Number.isInteger(page) || page < 0 || x2 <= x1 || y2 <= y1) continue;
    const old = regions.get(page);
    regions.set(page, old ? [
      Math.min(old[0], x1), Math.min(old[1], y1), Math.max(old[2], x2), Math.max(old[3], y2),
    ] : [x1, y1, x2, y2]);
  }
  return regions;
}

function needsRecovery(figure: HTMLElement): boolean {
  if (figure.dataset.sourceCropState === "unavailable") return true;
  if (figure.dataset.sourceCropState !== "loaded") return false;
  const images = [...figure.querySelectorAll<HTMLImageElement>(".sdt-source-crop-pages img")];
  return !images.length || images.some(image =>
    !image.getAttribute("src") || (image.complete && !image.naturalWidth));
}

/** Recreate failed SDT crops locally, without the native shared render batch. */
export function recoverReadingFigure(
  reader: any, view: any, figure: HTMLElement, cancelled = () => false,
): Promise<void> {
  const existing = pending.get(figure);
  if (existing) return existing;
  const doc = figure.ownerDocument;
  if (!doc || attempted.has(figure) || !needsRecovery(figure)) return Promise.resolve();

  const task = (queues.get(doc) || Promise.resolve()).then(async () => {
    const live = () => !cancelled() && !view?._destroyed && figure.isConnected;
    if (!live() || !needsRecovery(figure)) return;
    const container = figure.querySelector(".sdt-source-crop-pages");
    if (!container) return;
    attempted.add(figure);
    const regions = sourceRegions(view, figure);
    if (!regions.size) return;

    const crops = [];
    for (const [pageIndex, rect] of [...regions].sort((a, b) => a[0] - b[0])) {
      if (!live()) return;
      const src = await renderPDFRegion(reader, pageIndex, rect);
      if (!src) continue;
      const image = doc.createElement("img");
      image.alt = "";
      image.src = src;
      await image.decode();
      const page = doc.createElement("div");
      page.className = "sdt-source-crop-page";
      page.style.width = Math.min(800, image.naturalWidth) + "px";
      page.style.aspectRatio = image.naturalWidth + " / " + image.naturalHeight;
      page.append(image);
      crops.push(page);
    }
    // Keep the native DOM if only a subset of a multi-page figure could be recovered.
    if (live() && needsRecovery(figure) && crops.length === regions.size) {
      container.replaceChildren(...crops);
      figure.classList.add("sdt-source-crop-reserved");
      figure.dataset.sourceCropState = "loaded";
    }
  }).catch(error => {
    if (!cancelled() && !view?._destroyed) Zotero.logError(error as Error);
  }).finally(() => {
    pending.delete(figure);
    if (queues.get(doc) === task) queues.delete(doc);
  });
  pending.set(figure, task);
  queues.set(doc, task);
  return task;
}

/** Recover failed figures only as they approach the visible reading area. */
export function observeReadingFigures(reader: any, view: any, root: Element, win: Window): () => void {
  const mainWindow = Zotero.getMainWindow() as any;
  let disposed = false;
  const candidates = new Set<HTMLElement>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (disposed || !candidates.size || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      for (const figure of candidates) {
        if (!root.contains(figure) || !needsRecovery(figure) || attempted.has(figure)) {
          candidates.delete(figure);
          continue;
        }
        const { top, bottom } = figure.getBoundingClientRect();
        if (bottom < -160 || top > win.innerHeight + 160) continue;
        candidates.delete(figure);
        void recoverReadingFigure(reader, view, figure, () => disposed);
      }
    }, 50);
  };
  const watch = (figure: HTMLElement) => {
    if (root.contains(figure) && needsRecovery(figure) && !attempted.has(figure)) {
      candidates.add(figure);
      schedule();
    }
  };
  const mutations = new mainWindow.MutationObserver((records: MutationRecord[]) => {
    for (const { target } of records) {
      if ((target as Element).matches(CROP_SELECTOR)) watch(target as HTMLElement);
    }
  }) as MutationObserver;
  mutations.observe(root, { subtree: true, attributes: true, attributeFilter: ["data-source-crop-state"] });
  const onError = (event: Event) => {
    const figure = (event.target as Element)?.closest?.(CROP_SELECTOR);
    if (figure) watch(figure as HTMLElement);
  };
  root.addEventListener("error", onError, true);
  win.addEventListener("scroll", schedule, true);
  win.addEventListener("resize", schedule);
  for (const figure of root.querySelectorAll<HTMLElement>(CROP_SELECTOR)) watch(figure);
  return () => {
    disposed = true;
    mutations.disconnect();
    if (timer !== undefined) clearTimeout(timer);
    candidates.clear();
    win.removeEventListener("scroll", schedule, true);
    win.removeEventListener("resize", schedule);
    root.removeEventListener("error", onError, true);
  };
}
