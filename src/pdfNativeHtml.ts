import type { NativeBlock, NativeParser } from "./pdfNativeModel";

export interface NativeExportPage {
  pageIndex: number;
  image: string;
  blocks: Array<{ block: NativeBlock; translation: string }>;
}
function escapeHTML(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
/**
 * Printable transcript-only edition for vector PDF assembly; legacy snapshot
 * mode remains available for tests and compatibility. No SDT nodes are used.
 */
export function buildNativeBilingualHTML(
  pages: NativeExportPage[],
  title: string,
  parser: NativeParser,
  transcriptOnly = false,
  chineseOnly = false,
): string {
  const pageMarkup = pages.map(({ pageIndex, image, blocks }) => {
    if (!transcriptOnly && !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/u.test(image)) {
      throw new Error("原始页面图像缺失或无效，不能生成不完整的 PDF。");
    }
    const paragraphs = blocks.map(({ block, translation }) => {
      const enTag = block.type === "heading" ? "h3" : "p";
      if (chineseOnly) {
        const tag = block.type === "heading" ? "h3" : "p";
        return '<div class="unit"><' + tag + ' class="zh right">' +
          escapeHTML(translation || "〔未翻译〕 " + block.text) + '</' + tag + '></div>';
      }
      return '<div class="unit"><' + enTag + ' class="en">' +
        escapeHTML(block.text) + '</' + enTag + '><p class="zh">' +
        escapeHTML(translation || "〔此段未翻译〕") + '</p></div>';
    }).join("\n");
    const original = transcriptOnly ? "" :
      '<section class="original-page" data-page="' + (pageIndex + 1) + '">' +
      '<div class="page-label">Original PDF · page ' + (pageIndex + 1) + '</div>' +
      '<img alt="Original PDF page ' + (pageIndex + 1) + '" src="' + image + '">' + '</section>';
    return original + '<section class="translation-page" data-page="' + (pageIndex + 1) + '">' +
      '<div class="page-label">' + (chineseOnly ? "中文译文" : "中英对照") + " · 原始页 " + (pageIndex + 1) + '</div>' +
      (paragraphs || '<p class="empty">本页无可提取的正文；如为扫描版 PDF，需要 OCR。</p>') +
      '</section>';
  }).join("\n");
  const css = [
    "@page{size:A4;margin:16mm 17mm 20mm}",
    "html,body{background:#fff;color:#151515;margin:0;padding:0;height:auto;min-height:0;max-height:none;overflow:visible}",
    'body{font:10.5pt/1.48 Arial,"PingFang SC","Microsoft YaHei",sans-serif}',
    ".page-label{font:8pt Arial,sans-serif;color:#777;margin-bottom:2mm}",
    ".original-page{break-after:page;page-break-after:always;text-align:center}",
    ".original-page img{display:block;margin:0 auto;max-width:100%;max-height:230mm;height:auto;width:auto;object-fit:contain}",
    ".translation-page{break-after:page;page-break-after:always;height:auto;overflow:visible}",
    ".translation-page:last-child{break-after:auto;page-break-after:auto}",
    ".unit{break-inside:auto;page-break-inside:auto;margin:0 0 3mm}",
    "h3.en{font-size:11pt;margin:0;break-after:avoid-page}",
    "p.en{margin:0 0 1mm;overflow-wrap:anywhere}",
    "p.zh{margin:0 0 2.5mm;padding:0 0 0 2.5mm;color:#222;border-left:2pt solid #c7354a;white-space:pre-wrap;overflow-wrap:anywhere}",
    ".right{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6;margin:0 0 3mm;padding:0;border:0}",
    "h3.right{font-size:11pt;break-after:avoid-page}",
    "p{orphans:2;widows:2;break-inside:auto}",
    ".empty{color:#777}",
  ].join("\n");
  return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">" +
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'\"><title>" + escapeHTML(title) + "</title><style>" + css +
    "</style></head><body data-parser=\"" + parser + "\">" + pageMarkup + "</body></html>";
}
