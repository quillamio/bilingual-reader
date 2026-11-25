import type { NativeBlock, NativeParser } from "./pdfNativeModel";

export interface NativeExportPage {
  pageIndex: number;
  blocks: Array<{ block: NativeBlock; translation: string }>;
}
function escapeHTML(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
/** Print the native parser transcript as stacked original text and translation. */
export function buildNativeBilingualHTML(
  pages: NativeExportPage[],
  title: string,
  parser: NativeParser,
): string {
  const pageMarkup = pages.map(({ pageIndex, blocks }) => {
    const paragraphs = blocks.map(({ block, translation }) => {
      const enTag = block.type === "heading" ? "h3" : "p";
      return `<div class="unit"><${enTag} class="en">${escapeHTML(block.text)}</${enTag}><p class="zh">${escapeHTML(translation || "〔此段未翻译〕")}</p></div>`;
    }).join("\n");
    return '<section class="translation-page" data-page="' + (pageIndex + 1) + '">' +
      '<div class="page-label">' + "中英对照 · 原始页 " + (pageIndex + 1) + '</div>' +
      (paragraphs || '<p class="empty">本页无可提取的正文；如为扫描版 PDF，需要 OCR。</p>') +
      '</section>';
  }).join("\n");
  const css = [
    "@page{size:A4;margin:16mm 17mm 20mm}",
    "html,body{background:#fff;color:#151515;margin:0;padding:0;height:auto;min-height:0;max-height:none;overflow:visible}",
    'body{font:10.5pt/1.48 Arial,"PingFang SC","Microsoft YaHei",sans-serif}',
    ".page-label{font:8pt Arial,sans-serif;color:#777;margin-bottom:2mm}",
    ".translation-page{break-after:page;page-break-after:always;height:auto;overflow:visible}",
    ".translation-page:last-child{break-after:auto;page-break-after:auto}",
    ".unit{break-inside:auto;page-break-inside:auto;margin:0 0 3mm}",
    "h3.en{font-size:11pt;margin:0;break-after:avoid-page}",
    "p.en{margin:0 0 1mm;overflow-wrap:anywhere}",
    "p.zh{margin:0 0 2.5mm;padding:0 0 0 2.5mm;color:#222;border-left:2pt solid #c7354a;white-space:pre-wrap;overflow-wrap:anywhere}",
    "p{orphans:2;widows:2;break-inside:auto}",
    ".empty{color:#777}",
  ].join("\n");
  return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">" +
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\"><title>" + escapeHTML(title) + "</title><style>" + css +
    "</style></head><body data-parser=\"" + parser + "\">" + pageMarkup + "</body></html>";
}

export interface TranslatedPDFPage {
  pageIndex: number;
  paragraphs: Array<{ text: string; heading?: boolean }>;
  emptyMessage?: string;
  continuation?: boolean;
}

export function buildTranslatedPageHTML({ pageIndex, paragraphs, emptyMessage, continuation }: TranslatedPDFPage): string {
  const content = paragraphs.map(({ text, heading }) => {
    const tag = heading ? "h2" : "p";
    return `<${tag}>${escapeHTML(text)}</${tag}>`;
  }).join("\n");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>原始第 ${pageIndex + 1} 页译文</title>
<style>
  @page { size: A4; margin: 16mm 17mm 20mm; }
  body { margin: 0; color: #151515; font: 11pt/1.6 Arial, "PingFang SC", "Microsoft YaHei", sans-serif; }
  header { margin-bottom: 5mm; color: #666; font-size: 9pt; }
  h2, p { margin: 0 0 3mm; white-space: pre-wrap; overflow-wrap: anywhere; orphans: 2; widows: 2; }
  h2 { font-size: 12pt; break-after: avoid-page; }
</style></head><body>
<header>${continuation ? "译文续页" : "译文"} · 原始第 ${pageIndex + 1} 页</header>
${content || `<p>${escapeHTML(emptyMessage || "本页无已完成的译文。")}</p>`}
</body></html>`;
}
