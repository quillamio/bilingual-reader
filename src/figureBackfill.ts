type Rect = [number, number, number, number];

interface PageRect {
  pageIndex: number;
  rect: Rect;
}

interface StructureBlock {
  index: number;
  refPath: string;
  type: string;
  flowClass?: string;
  text: string;
  pageRects: PageRect[];
}

export interface FigureBackfillCandidate {
  refPath: string;
  pageIndex: number;
  rect: Rect;
}

interface BackfillEntry {
  figure: HTMLElement;
  candidate: FigureBackfillCandidate;
}

interface BackfillState {
  pending: Promise<void>;
}

const BACKFILL_CLASS = "bilingual-reader-backfill";
const FIGURE_CAPTION_RE =
  /^\s*(?:(?:extended\s+data\s+)?figure|fig\.?|图)\s*[0-9ivxlcdm]/iu;
const FIGURE_GAP = 4;
const FIGURE_SIDE_PADDING = 6;
const PAGE_TOP_MARGIN = 18;
const MIN_FIGURE_HEIGHT = 36;
const MIN_FIGURE_WIDTH = 30;
const TEXT_OVERLAP_REJECT_RATIO = 0.55;
const EXPORT_WAIT_MS = 30_000;

const backfillStates = new WeakMap<Document, BackfillState>();

function writeDebugLog(name: string, lines: string[]): void {
  try {
    const file = Zotero.getTempDirectory();
    file.append(name);
    void Zotero.File.putContentsAsync(file, lines.join("\n"));
  } catch (_) {
    // Diagnostics must never affect the reading view.
  }
}

function readPageRects(node: any): PageRect[] {
  const result: PageRect[] = [];
  const rawRects = node?.anchor?.pageRects;
  if (!Array.isArray(rawRects)) return result;

  for (const raw of rawRects) {
    if (!Array.isArray(raw) || raw.length !== 5 || !raw.every(Number.isFinite)) continue;
    const [pageIndex, x1, y1, x2, y2] = raw;
    if (!Number.isInteger(pageIndex) || pageIndex < 0) continue;
    const rect: Rect = [
      Math.min(x1, x2),
      Math.min(y1, y2),
      Math.max(x1, x2),
      Math.max(y1, y2),
    ];
    if (rect[2] <= rect[0] || rect[3] <= rect[1]) continue;
    result.push({ pageIndex, rect });
  }
  return result;
}

export function getBlockPlainText(node: any): string {
  if (!node || typeof node !== "object") return "";
  if (typeof node.text === "string") return node.text;
  if (!Array.isArray(node.content)) return "";

  let text = "";
  for (const child of node.content) {
    text += typeof child?.text === "string" ? child.text : getBlockPlainText(child);
  }
  return text;
}

export function collectStructureBlocks(structure: any): StructureBlock[] {
  const blocks: StructureBlock[] = [];
  const content = Array.isArray(structure?.content) ? structure.content : [];

  for (let index = 0; index < content.length; index++) {
    const block = content[index];
    if (!block || typeof block !== "object") continue;
    const pageRects = readPageRects(block);
    if (!pageRects.length) continue;
    blocks.push({
      index,
      refPath: String(index),
      type: String(block.type || ""),
      flowClass: typeof block.flowClass === "string" ? block.flowClass : undefined,
      text: getBlockPlainText(block),
      pageRects,
    });
  }
  return blocks;
}

function validViewRect(value: any): Rect | null {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)) return null;
  const rect: Rect = [value[0], value[1], value[2], value[3]];
  return rect[2] > rect[0] && rect[3] > rect[1] ? rect : null;
}

function horizontalOverlap(a: Rect, b: Rect): number {
  return Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
}

function rectArea(rect: Rect): number {
  return Math.max(0, rect[2] - rect[0]) * Math.max(0, rect[3] - rect[1]);
}

function intersectionArea(a: Rect, b: Rect): number {
  const width = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const height = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return width > 0 && height > 0 ? width * height : 0;
}

function clampRect(rect: Rect, viewRect: Rect): Rect {
  return [
    Math.max(viewRect[0], rect[0]),
    Math.max(viewRect[1], rect[1]),
    Math.min(viewRect[2], rect[2]),
    Math.min(viewRect[3], rect[3]),
  ];
}

function looksLikeFigureInternalText(
  block: StructureBlock,
  cropX: Rect,
  viewRect: Rect,
): boolean {
  if (block.type !== "paragraph") return false;
  const text = block.text.trim();
  if (!text || text.length > 1200 || !/[%\d]/u.test(text)) return false;

  if (block.flowClass === "excluded") {
    const nearPageTop = block.pageRects.some(
      (pageRect) => pageRect.rect[3] >= viewRect[3] - 40,
    );
    if (text.length <= 20 || nearPageTop) return false;

    const pageWidth = viewRect[2] - viewRect[0];
    const pageHeight = viewRect[3] - viewRect[1];
    const huge = block.pageRects.some((pageRect) => {
      const width = pageRect.rect[2] - pageRect.rect[0];
      const height = pageRect.rect[3] - pageRect.rect[1];
      return width >= pageWidth * 0.7 || height >= pageHeight * 0.5;
    });
    if (huge) return true;
  }

  const insideCrop = block.pageRects.some((pageRect) => {
    const width = pageRect.rect[2] - pageRect.rect[0];
    return width > 0 && horizontalOverlap(pageRect.rect, cropX) / width >= 0.8;
  });
  if (!insideCrop) return false;

  const sentenceMarks = text.match(/[.!?。！？]/gu);
  const sentenceLike = text.length > 400 && (sentenceMarks?.length ?? 0) >= 2;
  return !sentenceLike;
}

function getColumnClusters(
  pageIndex: number,
  blocks: StructureBlock[],
  viewRect: Rect,
): Rect[] {
  const intervals: Rect[] = [];
  for (const block of blocks) {
    if (block.flowClass === "excluded") continue;
    if (block.type !== "paragraph" && block.type !== "list") continue;
    for (const pageRect of block.pageRects) {
      if (pageRect.pageIndex !== pageIndex) continue;
      if (pageRect.rect[2] - pageRect.rect[0] < 20) continue;
      intervals.push(pageRect.rect);
    }
  }
  if (!intervals.length) return [];

  const merge = (source: Rect[]): Rect[] => {
    const sorted = [...source].sort((a, b) => a[0] - b[0]);
    const clusters: Rect[] = [];
    for (const rect of sorted) {
      const last = clusters[clusters.length - 1];
      if (last && rect[0] <= last[2] + 12) {
        last[2] = Math.max(last[2], rect[2]);
        last[1] = Math.min(last[1], rect[1]);
        last[3] = Math.max(last[3], rect[3]);
      } else {
        clusters.push([...rect] as Rect);
      }
    }
    return clusters;
  };

  const pageWidth = viewRect[2] - viewRect[0];
  const narrow = intervals.filter((rect) => rect[2] - rect[0] < pageWidth * 0.7);
  const narrowClusters = merge(narrow);
  const clusters = narrowClusters.length >= 2 ? narrowClusters : merge(intervals);
  return clusters.length ? clusters : [];
}

function getColumnRange(
  caption: StructureBlock,
  captionRect: PageRect,
  blocks: StructureBlock[],
  viewRect: Rect,
): Rect {
  const captionBox = captionRect.rect;
  const clusters = getColumnClusters(captionRect.pageIndex, blocks, viewRect);
  let best: Rect | null = null;
  let bestScore = -Infinity;

  const spanning = clusters.filter((cluster) => {
    const overlap = horizontalOverlap(cluster, captionBox);
    return overlap >= Math.min(20, (cluster[2] - cluster[0]) * 0.3);
  });
  if (spanning.length >= 2) {
    best = [
      Math.min(...spanning.map((cluster) => cluster[0])),
      viewRect[1],
      Math.max(...spanning.map((cluster) => cluster[2])),
      viewRect[3],
    ];
  }

  for (const cluster of clusters) {
    if (best) break;
    const overlap = horizontalOverlap(cluster, captionBox);
    const centerDistance = Math.abs(
      (cluster[0] + cluster[2]) / 2 - (captionBox[0] + captionBox[2]) / 2,
    );
    const score = overlap * 1000 - centerDistance;
    if (score > bestScore) {
      best = cluster;
      bestScore = score;
    }
  }

  if (!best || horizontalOverlap(best, captionBox) <= 0) {
    return [
      Math.max(viewRect[0], captionBox[0]),
      viewRect[1],
      Math.min(viewRect[2], captionBox[2]),
      viewRect[3],
    ];
  }

  return [
    Math.max(viewRect[0], best[0]),
    viewRect[1],
    Math.min(viewRect[2], best[2]),
    viewRect[3],
  ];
}

function hasNearbyImageBlock(
  caption: StructureBlock,
  captionRect: PageRect,
  blocks: StructureBlock[],
): boolean {
  for (const block of blocks) {
    if (block.type !== "image") continue;
    for (const pageRect of block.pageRects) {
      if (pageRect.pageIndex !== captionRect.pageIndex) continue;
      if (horizontalOverlap(pageRect.rect, captionRect.rect) <= 2) continue;
      const verticalDistance =
        pageRect.rect[1] >= captionRect.rect[3]
          ? pageRect.rect[1] - captionRect.rect[3]
          : captionRect.rect[1] - pageRect.rect[3];
      if (verticalDistance >= 0 && verticalDistance <= 200) return true;
    }
  }
  return false;
}

function computeFigureRect(
  caption: StructureBlock,
  captionRect: PageRect,
  blocks: StructureBlock[],
  viewRect: Rect,
): Rect | null {
  const captionBox = captionRect.rect;
  if (!FIGURE_CAPTION_RE.test(caption.text)) return null;
  if (captionBox[2] - captionBox[0] < 20) return null;

  const column = getColumnRange(caption, captionRect, blocks, viewRect);
  const left = Math.max(viewRect[0], column[0] - FIGURE_SIDE_PADDING);
  const right = Math.min(viewRect[2], column[2] + FIGURE_SIDE_PADDING);
  const cropX: Rect = [left, captionBox[1], right, captionBox[3]];
  if (right - left < MIN_FIGURE_WIDTH) return null;

  const bottom = captionBox[3] + FIGURE_GAP;
  let nearestAbove: StructureBlock | null = null;
  let nearestAboveRect: Rect | null = null;

  for (const block of blocks) {
    if (block === caption) continue;
    if (looksLikeFigureInternalText(block, cropX, viewRect)) continue;
    for (const pageRect of block.pageRects) {
      if (pageRect.pageIndex !== captionRect.pageIndex) continue;
      if (horizontalOverlap(pageRect.rect, cropX) <= 2) continue;
      if (pageRect.rect[1] < bottom - 0.5) continue;
      if (!nearestAboveRect || pageRect.rect[1] < nearestAboveRect[1]) {
        nearestAbove = block;
        nearestAboveRect = pageRect.rect;
      }
    }
  }

  const topLimit = nearestAboveRect ? nearestAboveRect[1] : viewRect[3] - PAGE_TOP_MARGIN;
  const top = Math.min(viewRect[3], topLimit - FIGURE_GAP);
  if (top - bottom < MIN_FIGURE_HEIGHT) return null;

  const crop = clampRect([left, bottom, right, top], viewRect);
  if (crop[2] - crop[0] < MIN_FIGURE_WIDTH || crop[3] - crop[1] < MIN_FIGURE_HEIGHT) {
    return null;
  }

  // Reject when ordinary text falls inside the candidate crop. Figure labels
  // extracted as text are intentionally treated the same way: a false negative
  // is safer than covering the figure with a second copy of its labels.
  for (const block of blocks) {
    if (block === caption || block === nearestAbove) continue;
    if (block.flowClass === "excluded" || block.type === "image") continue;
    for (const pageRect of block.pageRects) {
      if (pageRect.pageIndex !== captionRect.pageIndex) continue;
      const blockArea = rectArea(pageRect.rect);
      if (!blockArea) continue;
      if (intersectionArea(crop, pageRect.rect) / blockArea > TEXT_OVERLAP_REJECT_RATIO) {
        return null;
      }
    }
  }

  return crop;
}

export function planFigureBackfills(structure: any): FigureBackfillCandidate[] {
  const blocks = collectStructureBlocks(structure);
  if (!blocks.length) return [];

  const pages = Array.isArray(structure?.catalog?.pages) ? structure.catalog.pages : [];
  const candidates: FigureBackfillCandidate[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    if (block.type !== "caption" || !FIGURE_CAPTION_RE.test(block.text)) continue;

    for (const pageRect of block.pageRects) {
      const page = pages[pageRect.pageIndex];
      const viewRect = validViewRect(page?.viewRect);
      if (!viewRect) continue;
      if (hasNearbyImageBlock(block, pageRect, blocks)) continue;

      const crop = computeFigureRect(block, pageRect, blocks, viewRect);
      if (!crop) continue;

      const key = `${block.refPath}:${pageRect.pageIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        refPath: block.refPath,
        pageIndex: pageRect.pageIndex,
        rect: crop,
      });
    }
  }

  const deduped: FigureBackfillCandidate[] = [];
  for (const candidate of [...candidates].sort(
    (a, b) => rectArea(b.rect) - rectArea(a.rect),
  )) {
    const duplicate = deduped.some((existing) => {
      if (existing.pageIndex !== candidate.pageIndex) return false;
      const smaller = Math.min(rectArea(existing.rect), rectArea(candidate.rect));
      return smaller > 0 && intersectionArea(existing.rect, candidate.rect) / smaller > 0.5;
    });
    if (!duplicate) deduped.push(candidate);
  }

  return deduped.sort(
    (a, b) => a.pageIndex - b.pageIndex || a.rect[1] - b.rect[1],
  );
}

interface CropRendererHandle {
  renderer: any;
  window: any;
}

function findCropRenderer(reader: any): CropRendererHandle | null {
  const internal = reader?._internalReader || reader;
  if (!internal) return null;

  const primary = internal._lastViewPrimary !== false || !internal._secondaryView;
  const views = [
    primary ? internal._primaryView : internal._secondaryView,
    internal._primaryView,
    internal._secondaryView,
    internal._primaryPDFView,
    internal._secondaryPDFView,
  ];

  for (const view of views) {
    if (view?._pdfRenderer?.renderRegionCrops) {
      return {
        renderer: view._pdfRenderer,
        window: view._iframeWindow || view?._pdfView?._iframeWindow || null,
      };
    }
    const nested = view?._pdfView || view?._baseView;
    if (nested?._pdfRenderer?.renderRegionCrops) {
      return {
        renderer: nested._pdfRenderer,
        window: nested._iframeWindow || view?._iframeWindow || null,
      };
    }
  }
  return null;
}

function cloneIntoCompartment<T>(value: T, target: any): T {
  if (!target) return value;
  try {
    const utils =
      (globalThis as any).Components?.utils || (globalThis as any).Cu;
    if (utils?.cloneInto) return utils.cloneInto(value, target) as T;
  } catch (_) {
    // Fall back to the original value; the caller's try/catch handles failures.
  }
  return value;
}

interface PdfDocumentHandle {
  pdfDocument: any;
  window: any;
}

function findPdfDocument(reader: any): PdfDocumentHandle | null {
  const internal = reader?._internalReader || reader;
  const windows: any[] = [];

  const push = (value: any) => {
    if (value) windows.push(value);
  };

  try {
    push(reader?._iframeWindow);
    push(internal?._primaryView?._iframeWindow);
    push(internal?._secondaryView?._iframeWindow);
    push(internal?._primarySDTView?._iframeWindow);
    push(internal?._secondarySDTView?._iframeWindow);
    const frames = reader?._iframeWindow?.frames;
    if (frames) {
      for (let index = 0; index < frames.length; index++) push(frames[index]);
    }
  } catch (_) {
    // Accessing a detached or cross-origin frame must not break the feature.
  }

  for (const win of windows) {
    try {
      const pdfDocument = win?.PDFViewerApplication?.pdfDocument;
      if (pdfDocument?.getPage) return { pdfDocument, window: win };
    } catch (_) {
      // Try the next window.
    }
  }

  try {
    if (internal?._pdfDocument?.getPage) {
      return { pdfDocument: internal._pdfDocument, window: null };
    }
  } catch (_) {
    // Ignore inaccessible reader internals.
  }
  return null;
}

function cssAttributeValue(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

function createFigureElement(doc: Document, candidate: FigureBackfillCandidate): HTMLElement {
  const figure = doc.createElement("figure");
  figure.className = BACKFILL_CLASS;
  figure.dataset.refPath = candidate.refPath;
  figure.dataset.page = String(candidate.pageIndex);
  figure.dataset.state = "loading";
  return figure;
}

function trimCanvasToDataURL(doc: Document, dataURL: string): Promise<string | null> {
  return new Promise((resolve) => {
    const ImageConstructor = doc.defaultView?.Image;
    if (!ImageConstructor) {
      resolve(null);
      return;
    }

    const image = new ImageConstructor();
    image.onload = () => {
      try {
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        if (!width || !height) {
          resolve(null);
          return;
        }

        const canvas = doc.createElement("canvas") as HTMLCanvasElement;
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", {
          willReadFrequently: true,
        }) as CanvasRenderingContext2D | null;
        if (!context) {
          resolve(null);
          return;
        }
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, width, height).data;

        let minX = width;
        let minY = height;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const offset = (y * width + x) * 4;
            const alpha = pixels[offset + 3];
            const isInk =
              alpha > 16 &&
              (pixels[offset] < 245 || pixels[offset + 1] < 245 || pixels[offset + 2] < 245);
            if (!isInk) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }

        if (maxX < 0 || maxY < 0) {
          resolve(null);
          return;
        }

        const padding = 4;
        minX = Math.max(0, minX - padding);
        minY = Math.max(0, minY - padding);
        maxX = Math.min(width - 1, maxX + padding);
        maxY = Math.min(height - 1, maxY + padding);
        const cropWidth = maxX - minX + 1;
        const cropHeight = maxY - minY + 1;
        if (cropWidth < 8 || cropHeight < 8) {
          resolve(null);
          return;
        }

        const output = doc.createElement("canvas") as HTMLCanvasElement;
        output.width = cropWidth;
        output.height = cropHeight;
        const outputContext = output.getContext("2d") as CanvasRenderingContext2D | null;
        if (!outputContext) {
          resolve(null);
          return;
        }
        outputContext.drawImage(
          canvas,
          minX,
          minY,
          cropWidth,
          cropHeight,
          0,
          0,
          cropWidth,
          cropHeight,
        );
        resolve(output.toDataURL("image/png"));
      } catch (_) {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = dataURL;
  });
}

async function renderPageRectsFromPdfDocument(
  handle: PdfDocumentHandle,
  doc: Document,
  pageIndex: number,
  rects: Rect[],
): Promise<string[]> {
  const pdfDocument = handle.pdfDocument;
  const targetDocument = handle.window?.document || doc;
  const page = await pdfDocument.getPage(pageIndex + 1);
  const viewport = page.getViewport(
    cloneIntoCompartment({ scale: 2 }, handle.window),
  );
  const canvas = targetDocument.createElement("canvas") as HTMLCanvasElement;
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!context) return rects.map(() => "");

  await page.render(
    cloneIntoCompartment({ canvasContext: context, viewport }, handle.window),
  ).promise;

  const localRects = cloneIntoCompartment(rects, handle.window);
  const images: string[] = [];
  for (const rect of localRects) {
    try {
      const viewRect = viewport.convertToViewportRectangle(rect);
      const left = Math.max(0, Math.floor(Math.min(viewRect[0], viewRect[2])));
      const top = Math.max(0, Math.floor(Math.min(viewRect[1], viewRect[3])));
      const right = Math.min(canvas.width, Math.ceil(Math.max(viewRect[0], viewRect[2])));
      const bottom = Math.min(canvas.height, Math.ceil(Math.max(viewRect[1], viewRect[3])));
      const width = right - left;
      const height = bottom - top;
      if (width < 1 || height < 1) {
        images.push("");
        continue;
      }

      const output = targetDocument.createElement("canvas") as HTMLCanvasElement;
      output.width = width;
      output.height = height;
      const outputContext = output.getContext("2d") as CanvasRenderingContext2D | null;
      if (!outputContext) {
        images.push("");
        continue;
      }
      outputContext.drawImage(canvas, left, top, width, height, 0, 0, width, height);
      images.push(output.toDataURL("image/png"));
    } catch (_) {
      images.push("");
    }
  }
  return images;
}

async function renderBackfill(
  doc: Document,
  entries: BackfillEntry[],
  rendererHandle: CropRendererHandle | null,
  pdfHandle: PdfDocumentHandle | null,
): Promise<void> {
  const debug: string[] = [];
  const byPage = new Map<number, BackfillEntry[]>();
  for (const entry of entries) {
    const pageEntries = byPage.get(entry.candidate.pageIndex);
    if (pageEntries) pageEntries.push(entry);
    else byPage.set(entry.candidate.pageIndex, [entry]);
  }

  for (const [pageIndex, pageEntries] of byPage) {
    try {
      const rects = pageEntries.map((entry) => entry.candidate.rect);
      let images: any = null;
      if (rendererHandle) {
        try {
          const rendererRects = cloneIntoCompartment(
            rects,
            rendererHandle.window,
          );
          images = await rendererHandle.renderer.renderRegionCrops(
            pageIndex,
            rendererRects,
          );
          images = cloneIntoCompartment(images, globalThis);
          if (Array.isArray(images)) void images.length;
        } catch (error) {
          images = null;
          debug.push(
            `page=${pageIndex} rendererError=${(error as any)?.message || String(error)}`,
          );
        }
      }
      if (
        (!Array.isArray(images) || images.every((image: any) => !image)) &&
        pdfHandle
      ) {
        debug.push(`page=${pageIndex} usingPdfDocument=true`);
        images = await renderPageRectsFromPdfDocument(pdfHandle, doc, pageIndex, rects);
      }
      debug.push(
        `page=${pageIndex} entries=${pageEntries.length} images=${
          Array.isArray(images) ? images.length : "not-array"
        } firstLength=${Array.isArray(images) ? images[0]?.length : 0}`,
      );
      if (!Array.isArray(images)) continue;

      for (let index = 0; index < pageEntries.length; index++) {
        const entry = pageEntries[index];
        if (!entry.figure.isConnected) continue;
        const dataURL = images[index];
        if (!dataURL || typeof dataURL !== "string") {
          entry.figure.remove();
          continue;
        }
        const trimmed = await trimCanvasToDataURL(doc, dataURL);
        debug.push(
          `crop ${entry.candidate.refPath} data=${dataURL.length} trimmed=${
            trimmed?.length || 0
          } connected=${entry.figure.isConnected}`,
        );
        if (!trimmed || !entry.figure.isConnected) {
          entry.figure.remove();
          continue;
        }
        const image = doc.createElement("img");
        image.src = trimmed;
        image.alt = "Figure";
        entry.figure.replaceChildren(image);
        entry.figure.dataset.state = "loaded";
      }
    } catch (error) {
      debug.push(`page=${pageIndex} error=${(error as any)?.message || String(error)}`);
      Zotero.logError(error as Error);
      for (const entry of pageEntries) {
        try {
          entry.figure.remove();
        } catch (_) {
          // The reading view may already have been destroyed.
        }
      }
    }
  }

  writeDebugLog("bilingual-reader-backfill-render.log", debug);
}

export function clearFigureBackfill(doc: Document): void {
  backfillStates.delete(doc);
  const figures = Array.from(
    doc.querySelectorAll(`.${BACKFILL_CLASS}`),
  ) as HTMLElement[];
  for (const figure of figures) {
    try {
      figure.remove();
    } catch (_) {
      // Ignore detached reading-view nodes.
    }
  }
}

export function installFigureBackfill(
  reader: any,
  doc: Document,
  structure: any,
  enabled = true,
): void {
  const debug: string[] = [
    `install enabled=${enabled} structure=${!!structure} sdt=${!!doc.querySelector("#sdt-content")}`,
  ];
  if (!enabled || !structure) {
    writeDebugLog("bilingual-reader-backfill-install.log", debug);
    return;
  }

  clearFigureBackfill(doc);
  const candidates = planFigureBackfills(structure);
  debug.push(`candidates=${candidates.length}`);
  if (!candidates.length) {
    writeDebugLog("bilingual-reader-backfill-install.log", debug);
    return;
  }

  const rendererHandle = findCropRenderer(reader);
  const pdfHandle = findPdfDocument(reader);
  debug.push(
    `renderer=${!!rendererHandle} pdfDocument=${!!pdfHandle}`,
  );
  if (!rendererHandle && !pdfHandle) {
    const internal = reader?._internalReader || reader;
    try {
      debug.push(
        `views=${Object.keys(internal || {})
          .filter((key) => /view/iu.test(key))
          .join(",")}`,
      );
      debug.push(
        `rendererKeys=${Object.keys(internal?._primaryView || {})
          .filter((key) => /render/iu.test(key))
          .join(",")}`,
      );
    } catch (_) {
      debug.push("viewInspect=failed");
    }
    writeDebugLog("bilingual-reader-backfill-install.log", debug);
    return;
  }

  const entries: BackfillEntry[] = [];
  for (const candidate of candidates) {
    const selector = `#sdt-content [data-ref-path="${cssAttributeValue(candidate.refPath)}"]`;
    const caption = doc.querySelector<HTMLElement>(selector);
    debug.push(`candidate ${candidate.refPath} page=${candidate.pageIndex} found=${!!caption}`);
    if (!caption?.parentNode) continue;

    const figure = createFigureElement(doc, candidate);
    caption.parentNode.insertBefore(figure, caption);
    entries.push({ figure, candidate });
  }

  debug.push(`entries=${entries.length}`);
  writeDebugLog("bilingual-reader-backfill-install.log", debug);
  if (!entries.length) return;
  const pending = renderBackfill(doc, entries, rendererHandle, pdfHandle).finally(() => {
    for (const entry of entries) {
      if (entry.figure.isConnected && entry.figure.dataset.state === "loading") {
        entry.figure.remove();
      }
    }
  });
  backfillStates.set(doc, { pending });
}

export async function awaitFigureBackfill(doc: Document): Promise<void> {
  const state = backfillStates.get(doc);
  if (!state) return;

  try {
    await Promise.race([state.pending, Zotero.Promise.delay(EXPORT_WAIT_MS)]);
  } catch (error) {
    Zotero.logError(error as Error);
  }
}
