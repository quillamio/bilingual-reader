<p align="center">
  <img src="addon/content/icons/mahjong-red-dragon.svg" width="96" alt="Bilingual Reader" />
</p>

# Bilingual Reader

**Zotero 10 阅读模式 PDF 段落中英对照翻译。**

在 Zotero 10 的 PDF 阅读模式中读取结构化段落，将英文原文与中文译文按段落连续显示，适合论文精读。

> 本插件由 GPT 编写。

## 主要功能

- 🀄 一键开启 / 关闭 Zotero 原有阅读模式的段落中英对照。
- 📖 **PDF.js 原生双语阅读面板**：普通 PDF 页面视图下直接提取文本翻译，保留原始页面图片，不依赖 Zotero SDT 阅读模式。
- 📑 **PDF.js 原版保真双语导出**：直接复制原始 PDF 页面（保留原图、矢量和文字层），后附可搜索的英中对照页；支持 PDF.js、Docling、MinerU、Mistral OCR 和 LlamaParse 五种解析器。
- 默认调用 **Translate for Zotero** 的翻译服务（推荐使用google，其次必应）。
- 可选 **Ollama** 本地或云端模型。
- 自动缓存已完成译文。
- 支持短段落合并、受控并发、请求节流、超时与连续失败暂停。
- 可设置“不翻译末尾页数”，用于跳过参考文献。
- 🔄 可取消当前任务并按最新设置重新翻译。
- 🖨️ 可尝试将当前双语阅读结果导出为 PDF，并添加为当前文献的 Zotero 附件。

## 环境

- Zotero 10.x
- macOS 为主要测试平台
- 使用 Translate for Zotero 时，需要先安装并配置：
  https://github.com/windingwind/zotero-pdf-translate

## 安装

从本仓库 **Releases** 下载最新版 `.xpi` 文件，然后在 Zotero 中：

```text
工具 → 插件 → 右上角齿轮 → 从文件安装插件
```

安装后如有提示，请重启 Zotero。

## 使用

1. 在 Zotero 10 中打开英文 PDF。
2. 点击阅读器顶部 **🀄**。
3. 等待 Zotero 生成阅读模式结构化文本。
4. 中文译文会显示在对应英文段落下方。
5. 点击 **🔄** 可重新调度翻译。
6. 点击 **🖨️** 可导出双语 PDF。

可以配置：

- Translate for Zotero / Ollama；
- Translate for Zotero 固定跟随其当前默认服务；
- 不翻译末尾页数；
- 最大并发请求；
- 请求启动间隔；
- 单次请求最大字符数；
- 单次合并段落数；
- 请求超时；
- 连续失败后暂停；
- 翻译缓存清理。

## PDF 解析与导出（预览版）

Zotero 设置 → 中英对照 → 原始 PDF 解析，选择解析引擎。PDF.js 默认，不要求云端密钥。Docling 需本机运行 Python 服务（见 docs/native-pdfjs-docling.md）。

| 解析器 | 配置 | 申请/API 文档 |
| --- | --- | --- |
| PDF.js | 无 | Zotero 普通 PDF 页面 |
| Docling | 本机 HTTP 地址 | https://github.com/docling-project/docling |
| MinerU | Token，vlm / pipeline | https://mineru.net/apiManage/token |
| Mistral OCR | API Key，mistral-ocr-latest（默认） | https://console.mistral.ai/ |
| LlamaParse | API Key，fast / cost_effective / agentic / agentic_plus | https://cloud.llamaindex.ai/ |

各 API Key 独立保存在 Zotero 本地偏好中（非系统钥匙串），可清空。云服务每次上传原始 PDF 前需用户确认；可能计费，敏感未发表资料建议本地解析。初版云解析限制 30 MB；MinerU 使用 v4 批量上传与任务轮询，Mistral 返回每页 OCR Markdown，LlamaParse 使用 v2 文件解析任务。解析错误可显式回退本地 PDF.js；尚未使用真实付费账户完成全部端到端验证。PDF 解析和文字翻译是不同服务，需分别配置。

**📑 原版保真双语导出**：先打印按原始页码组织的可搜索双语译文，再使用 pdf-lib 直接复制原始 PDF 页面并合并。成品前部是完整原始 PDF，后部是双语译文；不再将原始页转成 JPEG。保留原页尺寸、旋转、内容流、字体和嵌入图片；新文件不保证保留原文档级签名、书签、表单和跨页链接。原始附件不变。

**🖨️ 旧版逐段重排导出**：清理读者视口的固定高度、裁切与位置样式，统一 A4 边距，等待 HTML 完全加载才打印。默认附加完整原始 PDF 作为附录；如果检测到漏图，继续导出时必须保留原始 PDF 附录。附录并非将缺失 Figure 插入其正文中的正确位置。若希望减小文件，可在设置中关闭默认附录（检测到疑似漏图时仍会提示附录）。

PDF 合并后重新读取校验总页数，导入 Zotero 为新附件；不覆盖原文件。CI 包含真实打印样本的独立渲染检查。

## 当前限制

- 目前主要面向英文 → 简体中文。
- 表格暂不逐单元格翻译。
- 数学公式不会作为普通文本翻译。
- PDF.js 无内置 OCR；扫描版可选择支持 OCR 的云服务，仍需人工校对。
- Zotero 阅读模式属于内部实现，后续 Zotero 更新可能需要重新适配。

## 图标

插件图标使用 Google Noto Emoji 的麻将红中图标，并本地打包到插件中，避免运行时依赖外部网络。

视觉来源：
https://images.emojiterra.com/google/noto-emoji/unicode-17.0/color/svg/1f004.svg

上游图形：
https://github.com/googlefonts/noto-emoji/blob/main/svg/emoji_u1f004.svg

Noto Emoji 图形资源采用 Apache License 2.0。

## 开发

```bash
npm install
npm run build
npm run test
```

## 许可证

AGPL-3.0-or-later
