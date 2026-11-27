<p align="center">
  <img src="addon/content/icons/mahjong-red-dragon.svg" width="96" alt="Bilingual Reader" />
</p>

# Bilingual Reader

**Zotero 10 阅读模式PDF 段落中英对照翻译**

在 Zotero 10 的 PDF 阅读模式中读取结构化段落，将英文原文与中文译文按段落连续显示，适合论文精读。Zotero 标记的图表区域加载失败时，会在滚动到附近后尝试从原 PDF 本地补绘。

> 本插件由 GPT 编写。

## 0.6.0-beta 新功能

- 阅读模式里的图表加载失败时，从原 PDF 按坐标在本机补绘。
- PDF 导出默认上下对照，可切换成左侧原 PDF、右侧可搜索译文。沿用原来的 🖨️ 按钮，无需额外排版服务。
- Zotero 阅读模式不可用时，可用已配置的 MinerU 接替解析。上传原 PDF 前会征求确认。
- 保留 Translate for Zotero 为默认引擎，沿用已保存的选择。新增独立服务配置、智谱 GLM-4.7-Flash，以及引擎旁的连接测试结果。
- 设置自动保存。可选择翻译整篇或跳过末页和参考文献，也可调整缓存段数。

Beta 如遇不稳定，可从 Releases 下载并重新安装 [v0.5.2 稳定版](https://github.com/quillamio/bilingual-reader/releases/tag/v0.5.2)。

## 主要功能

- 🀄 一键开启 / 关闭 Zotero 原有阅读模式的段落中英对照。
- **MinerU 阅读回退**：Zotero 阅读模式打不开或没有正文时，可以确认上传原 PDF 至 MinerU，继续上下双语阅读。
- **双语 PDF 导出**：默认上下对照，可切换为左侧原 PDF、右侧可搜索译文。支持 PDF.js、Docling、MinerU、Mistral OCR 和 LlamaParse 解析。
- 默认使用 **Translate for Zotero** 当前配置的翻译服务。也可选内置 Google 翻译（免 API Key）、Bing、Ollama 等引擎。
- 可选 **Ollama** 本地或云端模型。
- 自动缓存已完成译文，默认最多 1500 段，可调整段数。
- 支持短段落合并、受控并发、请求节流、超时与连续失败暂停。
- 翻译范围默认选「翻译非参考文献段落」，跳过末尾一页和 Zotero 标记的参考文献，单页 PDF 仍翻译正文。选「翻译所有页面」则纳入末页和参考文献。
- 🔄 可取消当前任务并按最新设置重新翻译。
- 🖨️ 可尝试将当前双语阅读结果导出为 PDF，并添加为当前文献的 Zotero 附件。

## 环境

- Zotero 10.x
- macOS 为主要测试平台
- 默认引擎需要安装并启用 [Translate for Zotero](https://github.com/windingwind/zotero-pdf-translate)。内置 Google 和 Bing 可独立使用。

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
6. 在设置中选择 **上下对照**（默认）或 **左右对照（原 PDF｜译文）**，然后点 **🖨️** 将 PDF 存为文献附件。左右对照逐页配对。左侧保留原始 PDF 的版面、图表及可选文字，右侧按原 PDF 坐标放入可搜索的译文，保留双栏、图表和分页。独立小标题单段加粗，导出时会按原 PDF 文本区域补译阅读模式漏掉的正文、标题和图注。右页的底图以图像嵌入。译文无法原位放入时，会流到对应的续页。每张原始 PDF 页面只在左侧出现一次。内置解析无需配置，复杂或扫描版可选 MinerU；Docling 和其他解析器仍可从设置中选择。

可以配置：

- 内置统一翻译引擎管理：各服务独立密钥、模型、端点、领域及测试；
- 兼容 Translate for Zotero / Ollama；
- 翻译范围与非参考文献模式跳过的末尾页数；
- 最大并发请求；
- 请求启动间隔；
- 单次请求最大字符数；
- 单次合并段落数；
- 请求超时；
- 连续失败后暂停；
- 翻译缓存段数与清理。

## 内置翻译引擎设置

在 Zotero 设置 → 中英对照 → 翻译后端，选择所需服务。免费服务可直接使用；需要 API Key 的服务必须填写各自的有效凭据。模型和端点等参数互相隔离，同一时间只使用所选服务。

**医学论文翻译建议**：优先测试 Google 以获得无需密钥的基本体验；专业医学术语可选择有道智云的“medicine”领域，或按需使用 Qwen-MT、Gemini、Claude 等服务，但应在论文关键结论、剂量、统计学方向等处人工核对。任何在线翻译都会将待翻译段落传输到外部服务，处理未发表或敏感资料时建议优先使用本地 Ollama / LibreTranslate / NLLB。

“测试此服务”会向该服务发送短句，可能产生 API 费用，不会自动测试所有服务。免费网页接口、签名 API、第三方兼容端点可能随时间改变，不保证运行时持续可用。

## PDF 解析与导出（预览版）

🀄 开启上下双语阅读，🖨️ 导出。解析引擎收在「解析和导出设置」下。PDF.js 默认，不要求云端密钥。Docling 需本机运行 Python 服务（见 docs/native-pdfjs-docling.md）。

| 解析器 | 配置 | 申请/API 文档 |
| --- | --- | --- |
| PDF.js | 无 | Zotero 普通 PDF 页面 |
| Docling | 本机 HTTP 地址 | https://github.com/docling-project/docling |
| MinerU | Token，vlm / pipeline | https://mineru.net/apiManage/token |
| Mistral OCR | API Key，mistral-ocr-latest（默认） | https://console.mistral.ai/ |
| LlamaParse | API Key，fast / cost_effective / agentic / agentic_plus | https://cloud.llamaindex.ai/ |

各 API Key 独立保存在 Zotero 本地偏好中（非系统钥匙串），可清空。云服务每次上传原始 PDF 前需用户确认；可能计费，敏感未发表资料建议本地解析。初版云解析限制 30 MB；MinerU 使用 v4 批量上传与任务轮询，Mistral 返回每页 OCR Markdown，LlamaParse 使用 v2 文件解析任务。解析错误可显式回退本地 PDF.js；尚未使用真实付费账户完成全部端到端验证。PDF 解析和文字翻译是不同服务，需分别配置。

**MinerU 阅读回退**：在「设置 → 中英对照 → 解析和导出设置」选择 MinerU，填写 Token。导出会复用已完成的解析和译文。上下版导出解析后的双语文本，左右版可复用与原 PDF 文字层匹配的 MinerU 译文。

**左右对照 PDF 正文覆盖**：以原始 PDF 的文字块为准核对译文。仅在原文文字匹配时复用阅读模式的译文，缺失块由选定的翻译引擎补译。若仍有未完成的文字块，导出前会提示涉及的页码和数量。

**🖨️ Zotero 阅读模式上下对照导出**：清理读者视口的固定高度、裁切与位置样式，统一 A4 边距，等待 HTML 完全加载才打印。导出会主动渲染尚未滚动到的 Zotero 原始 PDF 图表区域，并将图片直接嵌入双语正文。

PDF 合并后重新读取校验总页数，导入 Zotero 为新附件；不覆盖原文件。CI 包含真实打印样本的独立渲染检查。

## 内置翻译服务的注意事项

- Google 与 Bing 免密钥方案通过非官方网页翻译端点联网请求，**不是官方的有服务等级保证的 API**；可能受服务规则、网络地区、速率限制或端点调整影响。不能保证无限量或永久可用。
- 为降低限流及避免跨段错位，内置服务固定逐段串行，Google 最短请求间隔 750 毫秒，Bing 最短间隔 300 毫秒。可在设置中继续调大请求间隔。
- 文献正文会发送给所选择的在线翻译服务。敏感、未发表或受限制的数据请使用本地 Ollama 并自行核对隐私要求。
- 升级会保留已保存的翻译引擎。没有保存引擎选择时，默认使用 Translate for Zotero。
- 内置段落引擎覆盖免费、商业 API、自托管三类。各厂商的账户、付费额度、官方 API 授权及实际可用性仍由厂商决定。
- 部分词典（Cambridge、Collins、Bing Dict 等）只接受单词，不适合论文全文段落翻译，故不提供段落模式。Pot 只显示外部弹窗而不会返回译文。CNKI 和 Iciba 网页加密适配已集成，但服务可能触发人工验证或改变反爬参数，因此需要单独进行真实可用性测试。
- API Key 分服务保存在本地 Zotero 偏好配置中，不是 macOS 钥匙串加密存储；不要共享配置文件。更换密钥或模型会自动变更缓存命名空间。
- 语言方向当前固定为英文到简体中文；部分厂商对中英文语言代码的定义不同，适配层分别转换。

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

AGPL-3.0-or-later。Google / Bing 与其余服务适配器参考并改编自
[windingwind/zotero-pdf-translate](https://github.com/windingwind/zotero-pdf-translate)
的 `src/modules/services/`（AGPL-3.0）。相关实现文件顶部保留来源与许可声明。

## 致谢 / Acknowledgments

- [Bob](https://github.com/ripperhe/Bob)：参考产品的多服务选择与 OCR 交互；Bob 并非开源软件，本项目未复用其代码。
- [Easydict](https://github.com/tisfeng/Easydict)（GPL-3.0）：参考多服务独立配置及开箱即用的体验；本次未复制代码。
- [Translate for Zotero](https://github.com/windingwind/zotero-pdf-translate)（AGPL-3.0）及贡献者提供了本版参考和改编的服务适配器，来源在相应源码文件中注明。
- [ReadIN 译读](https://github.com/phoenix8701-ctrl/readin-yidu)（AGPL-3.0）：参考整页双语阅读及回存 Zotero 的交互；本次未复制代码。
- [Zotero Figure](https://github.com/MuiseDestiny/zotero-figure) 提供了从原 PDF 按区域裁图和按需渲染的设计参考。
- [Zotero Interlinear](https://github.com/Muanyan-mjq/zotero-interlinear) 与 [ChanceZhangcr 的 Bilingual Reader](https://github.com/ChanceZhangcr/zotero-bilingual-reader) 提供了阅读模式重排、左右配对与可搜索 PDF 导出的设计参考。
- [Zotero PDF2zh（guaguastandup 及贡献者）](https://github.com/guaguastandup/zotero-pdf2zh)（AGPL-3.0）：曾用于项目的左右对照导出实现。
- [PDFMathTranslate-next](https://github.com/PDFMathTranslate/PDFMathTranslate-next) 与 [BabelDOC](https://github.com/funstory-ai/BabelDOC)：曾为 Zotero PDF2zh 集成提供排版翻译引擎。BabelDOC 的按页按块处理中间结构为本版导出覆盖检查提供了设计参考。
- [Zotero 的 Make It Red 示例](https://github.com/zotero/make-it-red) 提供了插件启动代码的基础。
- [Google Noto Emoji](https://github.com/googlefonts/noto-emoji)（Apache-2.0）提供了麻将红中图标。
- [pdf-lib](https://github.com/Hopding/pdf-lib)（MIT）：实际打包依赖，用于嵌入原始 PDF 页面；相关第三方许可证见 addon/content/licenses/pdf-export-dependencies.txt。

### 左右对照直接生成（实验性）

设置 → 双语阅读与 PDF 导出 → 解析和导出设置 → 左右对照生成方式。自动模式优先使用 pdf-lib 和 @pdf-lib/fontkit 直接写入可检索的中文文字对象，缺字或生成失败时逐页回退到兼容打印。仅直接生成模式用于诊断，不静默回退。左侧原页保持矢量内容，右侧使用现有安全遮盖后的原页图像，无法安全放回原位的译文放到续页；右侧底图不是全矢量。上下对照默认仍使用旧打印路径。

构建时通过 `npm run prepare:pdf-font` 获取固定提交的 [Noto Sans CJK SC](https://github.com/notofonts/noto-cjk/tree/523d033d6cb47f4a80c58a35753646f5c3608a78)（SIL Open Font License 1.1），校验原始 Git blob 哈希，并将字体和许可证随 XPI 打包。导出期间不下载字体，也不上传 PDF。感谢 Noto CJK、[pdf-lib](https://github.com/Hopding/pdf-lib) 及 [@pdf-lib/fontkit](https://github.com/Hopding/fontkit) 项目。字体原始授权见插件内 fonts/OFL-NotoCJK.txt。

### BelinDoc 云端整篇导出（实验性）
选择设置中的 BelinDoc 导出服务，填写 [官方开发者中心](https://belindoc.com/docs) API Key 和 getModelList 返回的模型版本。默认仍是本地导出。用户首先确认上传整篇原始 PDF，然后确认模型额度系数和 OCR，再提交一次任务。支持左右对照、上下对照、仅译文。共享官网额度和水印规则，不承诺无限免费；当前本地限制 30 MB。API Key 保存在本地首选项，勿共享配置文件。云端取消不保证停止计费或删除上传文件，失败/超时后先查服务历史。云端输出不能继承本地科学符号校验、跳页、段落缓存或断点。当前仅按官方文档和模拟响应验证，真实账户联调待验收。参考官方文档更新日期 2026-09-04。

### 新增本地与云端后端（实验性）
详见 [安装、配置及隐私说明](docs/external-backends.md)。BabelDOC/PDF2zh-next 需自行安装并启动本机桥接；Doc2X、Mathpix 为云端解析；SiliconFlow、OpenRouter、Google Cloud 为独立段落翻译服务。Doclingo 官方接口文档待取得，未伪造协议。上述服务不保证免费。

### 第三方来源补充
- [BabelDOC](https://github.com/funstory-ai/BabelDOC) 与 [PDFMathTranslate-next](https://github.com/PDFMathTranslate/PDFMathTranslate-next)：AGPL-3.0，上游独立 CLI，不随插件分发其 Python 源码或模型权重；桥接按公开 CLI 文档自行实现。
- [zotero-interlinear](https://github.com/Muanyan-mjq/zotero-interlinear)（AGPL-3.0-or-later）与 [zotero-bilingual-reader](https://github.com/ChanceZhangcr/zotero-bilingual-reader)（MIT）：参考容灾和导出架构，未直接复制其实现。
- [Bob](https://github.com/ripperhe/Bob) 与 [Easydict](https://github.com/tisfeng/Easydict)：翻译工具设计参考，本批次未复制源码。
- Doc2X、Mathpix、SiliconFlow、OpenRouter、Google Cloud、BelinDoc：通过公开 API 协议独立实现，不表示获得其专有软件的再分发许可；使用受各服务条款约束。
- @pdf-lib/fontkit（MIT）、Noto Sans CJK SC（SIL OFL 1.1）：字体依赖及许可证按构建分发。诊断报告不自动上传。

字体兼容性回归：第8项实测发现 CFF/OTF 子集可提取但在 MuPDF 中无可见中文字形；构建改用同一固定上游提交的 Noto Sans SC TrueType 变体，保留原有中文可见性检查，待 CI 验证。Fontkit 上游 MIT 授权全文已补入 addon/content/licenses/pdf-export-dependencies.txt。
