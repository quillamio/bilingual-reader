export type SegmentType = "title" | "heading" | "paragraph" | "caption" | "reference";
export interface Segment { id: string; type: SegmentType; sourceText: string; translation?: string; }
const PLUGIN_ID = "bilingual-reader@zotero.local";
const BASE = "extensions.zotero.bilingualreader";
function pref(name: string, fallback: string): string {
  const value = (Zotero.Prefs as any).get(`${BASE}.${name}`);
  return typeof value === "string" ? value : fallback;
}
function hash(text: string): string {
  let result = 2166136261;
  for (let i = 0; i < text.length; i++) result = Math.imul(result ^ text.charCodeAt(i), 16777619);
  return (result >>> 0).toString(16);
}
export function extractReaderText(reader: any): string {
  const candidates = [reader?._iframeWindow?.document?.body?.innerText, reader?._window?.document?.body?.innerText, reader?.document?.body?.innerText];
  const text = candidates.find((value) => typeof value === "string" && value.trim());
  if (!text) throw new Error("未能读取 Zotero 阅读模式文本。请先切换到阅读模式后重试。");
  return text.replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").trim();
}
export function segmentText(text: string): Segment[] {
  const blocks = text.split(/\n\s*\n+/).map((item) => item.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
  return blocks.map((sourceText, index) => ({
    id: `p-${String(index + 1).padStart(5, "0")}`,
    type: index === 0 && sourceText.length < 180 ? "title" : /^(abstract|introduction|results|discussion|methods|references)\b/i.test(sourceText) ? "heading" : /^(figure|fig\.|table)\s*\d+/i.test(sourceText) ? "caption" : /\bdoi\b|https?:\/\//i.test(sourceText) ? "reference" : "paragraph",
    sourceText,
  }));
}
export function loadCached(itemKey: string, segments: Segment[]): Segment[] {
  return segments.map((segment) => {
    const value = (Zotero.Prefs as any).get(`${BASE}.cache.${itemKey}.${hash(segment.sourceText)}.zh-CN`);
    return typeof value === "string" && value ? { ...segment, translation: value } : segment;
  });
}
function saveCached(itemKey: string, segment: Segment, translation: string) {
  (Zotero.Prefs as any).set(`${BASE}.cache.${itemKey}.${hash(segment.sourceText)}.zh-CN`, translation);
}
async function translateOne(text: string, itemID: number): Promise<string> {
  const pdfTranslate = (Zotero as any).PDFTranslate;
  if (!pdfTranslate?.api?.translate) throw new Error("请先安装并启用 Translate for Zotero（zotero-pdf-translate）。");
  const task = await pdfTranslate.api.translate(text, { pluginID: PLUGIN_ID, itemID, langfrom: "en-US", langto: "zh-CN" });
  if (!task?.result) throw new Error("Translate for Zotero 未返回译文，请检查其服务配置。");
  return String(task.result);
}
export async function translateMissing(itemKey: string, itemID: number, segments: Segment[], onProgress?: (done: number, total: number) => void) {
  const result = [...segments];
  const missing = result.filter((segment) => !segment.translation && segment.type !== "reference");
  for (let index = 0; index < missing.length; index++) {
    const segment = missing[index];
    segment.translation = await translateOne(segment.sourceText, itemID);
    saveCached(itemKey, segment, segment.translation);
    onProgress?.(index + 1, missing.length);
  }
  return result;
}
function escapeHTML(value: string) { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]!)); }
function renderWindow(win: Window, segments: Segment[], status: string) {
  const body = segments.map((segment) => `<article><div class="source">${escapeHTML(segment.sourceText)}</div><div class="translation">${segment.translation ? escapeHTML(segment.translation) : "待翻译"}</div></article>`).join("");
  win.document.open();
  win.document.write(`<!doctype html><meta charset="utf-8"><title>中英对照阅读</title><style>body{margin:0;background:#f7f7f5;color:#222;font:16px/1.75 system-ui,-apple-system,"Noto Sans SC",sans-serif}.toolbar{position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd;padding:12px 8%;color:#777}.content{max-width:900px;margin:30px auto;padding:0 32px}article{margin:0 0 30px}.translation{border-left:4px solid #c7354a;margin-top:10px;padding:8px 18px;white-space:pre-wrap}</style><div class="toolbar">Zotero 中英对照阅读　${escapeHTML(status)}</div><main class="content">${body}</main>`);
  win.document.close();
}
export async function openBilingualWindow(reader: any) {
  const itemID = Number(reader?.itemID || 0);
  const itemKey = String(reader?.itemKey || itemID || "reader");
  const segments = loadCached(itemKey, segmentText(extractReaderText(reader)));
  const win = (Zotero.getMainWindow() as any).open("about:blank", "zotero-bilingual-reader", "chrome,resizable,centerscreen,width=980,height=860");
  if (!win) throw new Error("无法打开双语阅读窗口。");
  renderWindow(win, segments, "翻译由 Translate for Zotero 提供");
  try { const translated = await translateMissing(itemKey, itemID, segments, (done, total) => renderWindow(win, segments, `正在翻译 ${done}/${total}…`)); renderWindow(win, translated, ""); } catch (error: any) { renderWindow(win, segments, error?.message || String(error)); }
}
