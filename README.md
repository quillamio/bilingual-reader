# Zotero Bilingual Reader

本插件为 Zotero 10 PDF 阅读模式提供独立的中英段落对照窗口。翻译能力直接调用 [Translate for Zotero / zotero-pdf-translate](https://github.com/windingwind/zotero-pdf-translate) 的公开 API，因此 Google Translate、OpenAI-compatible API 以及该插件支持的其他翻译服务都由 Translate for Zotero 统一配置和管理。

## 依赖与安装

请先安装并启用 Translate for Zotero，然后安装 `bilingual-reader-0.1.0.xpi`。在 Zotero 的“工具 → 插件”中，点击齿轮菜单，选择“从文件安装插件…”。

## 使用

打开 PDF 并切换到 Zotero 10 的“阅读模式”，点击 Reader 工具栏中的“中英对照”。插件会提取阅读模式中的文本，按段落切分，逐段调用 Translate for Zotero API，并在独立窗口中显示英文原文与中文译文。

要选择 Google Translate 或 OpenAI-compatible API，请进入 Translate for Zotero 的设置页，在“Service�要选择�对应服务。Translate for Zotero 的默认服务就是 Google Translate；如果选择 GPT，则在该插件中配置 OpenAI-compatible API。

## 实现说明

插件通过 `Zotero.PDFTranslate.api.translate(raw, options)` 调用 Translate for Zotero，传入 `pluginID`、`itemID`、`langfrom: "en-US"` 和 `langto: "zh-CN"`。已翻译段落按原文哈希缓存在 Zotero 偏好中，避免重复请求。

如果 Translate for Zotero 未安装、未启用或其服务配置错误，双语窗口会显示明确错误信息，而不是再次绕过该插件调用外部翻译服务。

## 构建

```bash
npm install
npm run build
```

构建产物为 `bilingual-reader-0.1.0.xpi`。
