/** A stacked bilingual reader when Zotero cannot produce its SDT reading view. */
import { getNormalPDFProxy, parseNormalPDFWithPDFJS } from "./pdfNativeRuntime";
import { getCloudKey, parseWithCloudProvider } from "./pdfCloudParsers";
import { readOriginalAttachment } from "./pdfVectorExport";
import { translateNativeDocument } from "./pdfNativeExport";
import { describePDFParser, type NativeDocument } from "./pdfNativeModel";

export interface MinerUReadingResult {
  document: NativeDocument;
  translations: Map<string, string>;
}

interface PanelSession {
  host: HTMLElement;
  closed: boolean;
  result?: MinerUReadingResult;
}
const panels = new WeakMap<object, PanelSession>();

export function hasMinerUReadingFallback(reader: object): boolean {
  return panels.has(reader);
}

export function getMinerUReadingResult(reader: object): MinerUReadingResult | undefined {
  return panels.get(reader)?.result;
}

function createPanel(doc: Document, onClose: () => void): {
  host: HTMLElement;
  body: HTMLElement;
  status: HTMLElement;
} {
  const host = doc.createElement("aside") as HTMLElement;
  host.className = "bilingual-reader-mineru-reading";
  host.style.cssText =
    "position:fixed;inset:41px 0 0;z-index:2147483600;" +
    "background:Canvas;color:CanvasText;display:flex;flex-direction:column;overflow:hidden;";
  const shadow = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = [
    ":host{font:15px/1.65 system-ui,'PingFang SC',sans-serif}",
    "*{box-sizing:border-box}",
    ".head{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #ddd;background:Canvas}",
    ".head button{cursor:pointer;font-size:14px;padding:2px 8px}",
    ".status{font-size:13px;background:Canvas;padding:6px 12px}",
    ".body{flex:1;overflow-y:auto;padding:16px max(18px,calc((100% - 860px)/2))}",
    ".page{padding:10px 0;border-bottom:1px solid #dedede}",
    ".page h4{display:flex;justify-content:space-between;align-items:center;margin:0 0 12px;font-size:13px}",
    ".unit{margin-bottom:10px}",
    ".en{white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 4px}",
    ".zh{border-left:3px solid #c7354a;padding:2px 8px;margin:0 0 6px;white-space:pre-wrap;overflow-wrap:anywhere}",
  ].join("\n");
  const header = doc.createElement("div"); header.className = "head";
  const title = doc.createElement("strong"); title.textContent = "MinerU 上下对照";
  const close = doc.createElement("button"); close.type = "button"; close.textContent = "返回原始 PDF";
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
): Map<string, HTMLElement> {
  const destinations = new Map<string, HTMLElement>();
  for (const page of document.pages) {
    const section = doc.createElement("section"); section.className = "page";
    const heading = doc.createElement("h4");
    heading.textContent = "原始 PDF 第 " + (page.index + 1) + " 页";
    section.append(heading);
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
export async function openMinerUReadingFallback(reader: any): Promise<void> {
  if (hasMinerUReadingFallback(reader)) return;
  if (!getCloudKey("mineru")) {
    throw new Error("Zotero 阅读模式不可用。可在「设置 → 中英对照 → 解析和导出设置」选择 MinerU 并填写 Token。");
  }
  const win = typeof reader._iframeWindow?.confirm === "function" ? reader._iframeWindow : Zotero.getMainWindow();
  if (!win?.confirm("Zotero 阅读模式不可用。是否把完整 PDF 上传到 MinerU，改用上下双语对照？")) return;

  const doc = reader._iframeWindow?.document as Document | undefined;
  if (!doc?.body) throw new Error("无法打开 MinerU 双语阅读页。");
  const ui = createPanel(doc, () => cleanupNativeReadingPanel(reader));
  const session: PanelSession = { host: ui.host, closed: false };
  panels.set(reader, session);
  try {
    const attachment = Zotero.Items.get(Number(reader.itemID || 0));
    const handle = getNormalPDFProxy(reader);
    if (!attachment || !handle) throw new Error("无法读取原始 PDF 附件。");
    const original = await parseNormalPDFWithPDFJS(handle, undefined, () => session.closed);
    if (session.closed) return;
    ui.status.textContent = "MinerU 正在解析 PDF…";
    const bytes = await readOriginalAttachment(attachment);
    const parsed = await parseWithCloudProvider("mineru", bytes, original, () => session.closed);
    if (session.closed) return;

    const destination = paintParagraphs(doc, ui.body, parsed);
    const parserStatus = describePDFParser(parsed, "mineru");
    ui.status.textContent = parserStatus + " · 正在翻译…";
    const translations = await translateNativeDocument(
      parsed, attachment.id, attachment.key,
      (done, total) => {
        if (!session.closed) ui.status.textContent = parserStatus + " · 翻译 " + done + "/" + total;
      },
      () => session.closed,
    );
    if (session.closed) return;
    session.result = { document: parsed, translations };
    for (const [id, element] of destination) {
      element.textContent = translations.get(id) || "〔未翻译〕";
    }
    ui.status.textContent = "已完成 · " + parserStatus + " · " + translations.size + " 段译文";
  } catch (error) {
    if (session.closed) return;
    Zotero.logError(error as Error);
    ui.status.textContent = "MinerU 回退阅读失败：" + (error as Error).message;
  }
}

export function cleanupNativeReadingPanel(reader: object): void {
  const session = panels.get(reader);
  if (!session) return;
  session.closed = true;
  session.host.remove();
  panels.delete(reader);
}
