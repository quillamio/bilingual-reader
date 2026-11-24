/**
 * A bilingual side panel in Zotero's *ordinary PDF view*. Keeps original
 * PDF.js page rendering (including figures/tables) visible in the normal
 * viewer and shows extracted bilingual paragraphs beside it.
 * No SDT structure, reading-mode toggle, or #sdt-content required.
 */
import { getNormalPDFProxy, parseNormalPDFWithPDFJS } from "./pdfNativeRuntime";
import { isCloudParser, CLOUD_NAMES } from "./pdfCloudModel";
import { parseWithCloudProvider } from "./pdfCloudParsers";
import { readOriginalAttachment } from "./pdfVectorExport";
import { getNativePDFBackend, getDoclingEndpoint, parseWithLocalDocling } from "./pdfNativeDocling";
import { translateNativeDocument } from "./pdfNativeExport";
import { describePDFParser, PDF_PARSER_NAMES, type NativeDocument } from "./pdfNativeModel";

interface PanelSession {
  host: HTMLElement;
  closed: boolean;
  restoreViewer: () => void;
}
const panels = new WeakMap<object, PanelSession>();
const PANEL_CLASS = "bilingual-reader-pdfjs-reading-panel";
const PANEL_WIDTH = "min(40%, 560px)";

function showPage(win: any, page: number): void {
  try {
    const view = win?.wrappedJSObject || win;
    if (view?.PDFViewerApplication) view.PDFViewerApplication.page = page;
  } catch (_) { /* Viewer may be gone */ }
}
function createPanel(doc: Document, onClose: () => void): {
  host: HTMLElement;
  body: HTMLElement;
  status: HTMLElement;
} {
  const host = doc.createElement("aside") as HTMLElement;
  host.className = PANEL_CLASS;
  host.style.cssText =
    "position:fixed!important;inset-inline-end:0!important;top:41px!important;" +
    `width:${PANEL_WIDTH}!important;bottom:0!important;` +
    "z-index:2147483600!important;background:white!important;" +
    "border-left:1px solid #d5d5d5;box-shadow:-2px 0 15px #0002;" +
    "display:block!important;overflow:hidden!important;";
  const shadow = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = [
    ":host{font:13px/1.6 Arial,'PingFang SC',sans-serif;color:#202020}",
    "*{box-sizing:border-box}",
    ".head{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #ddd;background:#f7f7f7}",
    ".head button{cursor:pointer;font-size:14px;padding:2px 8px}",
    ".status{font-size:12px;color:#555;background:#f4f6fa;padding:6px 12px}",
    ".body{height:calc(100% - 79px);overflow-y:auto;padding:12px}",
    ".page{padding:10px 0;border-bottom:1px solid #dedede}",
    ".page h4{display:flex;justify-content:space-between;align-items:center;margin:0 0 12px;font-size:13px}",
    ".unit{margin-bottom:10px}",
    ".en{font-size:12px;color:#454545;white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 4px}",
    ".zh{font-size:13px;border-left:3px solid #c7354a;padding:2px 8px;margin:0 0 6px;white-space:pre-wrap;overflow-wrap:anywhere}",
    ".jump{border:1px solid #aaa;border-radius:4px;padding:2px 7px;cursor:pointer;background:#fff}",
  ].join("\n");
  const header = doc.createElement("div"); header.className = "head";
  const title = doc.createElement("strong"); title.textContent = "PDF.js 双语阅读（原始页面保真）";
  const close = doc.createElement("button"); close.type = "button"; close.textContent = "关闭";
  close.addEventListener("click", onClose);
  header.append(title, close);
  const status = doc.createElement("div"); status.className = "status";
  status.textContent = "正在读取原始 PDF...";
  const body = doc.createElement("div"); body.className = "body";
  shadow.append(style, header, status, body);
  const root = doc.body || doc.documentElement;
  if (!root) throw new Error("PDF viewer document has no root element.");
  root.append(host);
  return { host, body, status };
}

function paintParagraphs(
  doc: Document, target: HTMLElement, document: NativeDocument,
  win: any,
): Map<string, HTMLElement> {
  const destinations = new Map<string, HTMLElement>();
  for (const page of document.pages) {
    const section = doc.createElement("section"); section.className = "page";
    const heading = doc.createElement("h4");
    const label = doc.createElement("span");
    label.textContent = "原始 PDF 第 " + (page.index + 1) + " 页";
    const jump = doc.createElement("button");
    jump.className = "jump";
    jump.type = "button";
    jump.textContent = "跳转原页";
    jump.addEventListener("click", () => showPage(win, page.index + 1));
    heading.append(label, jump); section.append(heading);
    for (const block of page.blocks) {
      if (block.text.trim().length < 2 || block.type === "picture" || block.type === "formula") {
        continue;
      }
      const wrapper = doc.createElement("div");
      wrapper.className = "unit";
      const english = doc.createElement("p");
      english.className = "en"; english.textContent = block.text;
      const chinese = doc.createElement("p");
      chinese.className = "zh"; chinese.textContent = "正在翻译 / 尚未缓存…";
      wrapper.append(english, chinese); section.append(wrapper);
      destinations.set(block.id, chinese);
    }
    target.append(section);
  }
  return destinations;
}
export async function togglePDFJSReadingPanel(reader: any, refresh = false): Promise<void> {
  if (!reader || typeof reader !== "object") return;
  const previous = panels.get(reader);
  if (previous) {
    cleanupNativeReadingPanel(reader);
    if (!refresh) return;
  }
  const doc = reader?._iframeWindow?.document as Document | undefined;
  if (!doc?.body) return;
  const ui = createPanel(doc, () => cleanupNativeReadingPanel(reader));
  const viewer = doc.getElementById("split-view") as HTMLElement | null;
  const inset = viewer?.style.insetInlineEnd || "";
  const session: PanelSession = {
    host: ui.host,
    closed: false,
    restoreViewer: () => { if (viewer) viewer.style.insetInlineEnd = inset; },
  };
  panels.set(reader, session);
  if (viewer) viewer.style.insetInlineEnd = PANEL_WIDTH;
  try {
    const internal = reader._internalReader || reader;
    const primary = internal._lastViewPrimary !== false || !internal._secondaryView;
    if (primary ? internal._primarySDTView : internal._secondarySDTView) {
      await internal._setReadingMode?.(primary, false);
    }
    if (session.closed) return;
    const handle = getNormalPDFProxy(reader);
    if (!handle) throw new Error("未检测到普通 PDF 页面的 PDF.js 实例，请切回普通页面视图。");
    const provider = getNativePDFBackend();
    const original = await parseNormalPDFWithPDFJS(handle, (state) => {
      if (!session.closed) ui.status.textContent =
        "读取 PDF.js 页面：" + state.page + "/" + state.pages;
    }, () => session.closed);
    if (session.closed) return;
    let parsed = original;
    const attachment = Zotero.Items.get(Number(reader.itemID || 0));
    if (provider !== "pdfjs") {
      if (isCloudParser(provider)) {
        const win = Zotero.getMainWindow() as any;
        if (!win?.confirm?.("即将上传完整原始 PDF 至 " + CLOUD_NAMES[provider] +
          "，可能产生费用。请勿上传未经授权的敏感文献。\n\n同意上传？")) {
          ui.status.textContent = "未授权云端解析，已停止。"; return;
        }
      }
      try {
        ui.status.textContent = "正在解析：" + PDF_PARSER_NAMES[provider];
        const bytes = await readOriginalAttachment(attachment);
        parsed = provider === "docling" ?
          await parseWithLocalDocling(bytes, getDoclingEndpoint(), original) :
          await parseWithCloudProvider(provider, bytes, original, () => session.closed);
      } catch (error) {
        if (session.closed) return;
        const win = Zotero.getMainWindow() as any;
        if (!win?.confirm?.("解析失败：" + String((error as Error)?.message || error) +
          "\n是否回退 PDF.js？")) {
          ui.status.textContent = "解析已停止。"; return;
        }
      }
    }
    if (session.closed) return;
    const destination = paintParagraphs(doc, ui.body, parsed, handle.contentWindow);
    const parserStatus = describePDFParser(parsed, provider);
    ui.status.textContent = parserStatus + " · 正在翻译 " + parsed.pages.length + " 页";
    const result = await translateNativeDocument(
      parsed, Number(reader.itemID || 0), String(attachment?.key || reader.itemID || ""),
      (done, total) => {
        if (!session.closed) ui.status.textContent = parserStatus + " · 翻译 " + done + "/" + total;
      },
      () => session.closed,
    );
    if (session.closed) return;
    for (const [id, element] of destination) {
      element.textContent = result.get(id) || "〔未翻译 / 尾页已跳过〕";
    }
    ui.status.textContent = "已完成 · " + parserStatus +
      " · " + result.size + " 段译文";
  } catch (error) {
    Zotero.logError(error as Error);
    if (!session.closed) ui.status.textContent =
      "解析/翻译失败：" + String((error as Error)?.message || error);
  }
}

export function cleanupNativeReadingPanel(reader: any): void {
  const session = panels.get(reader);
  if (!session) return;
  session.closed = true;
  session.host.remove();
  session.restoreViewer();
  panels.delete(reader);
}
