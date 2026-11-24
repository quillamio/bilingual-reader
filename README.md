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
- 默认内置 **Google 翻译（免 API Key）**；独立段落翻译引擎，另有 Ollama 与 Translate for Zotero 兼容模式。
- 可选 **Ollama** 本地或云端模型。
- 自动缓存已完成译文。
- 支持短段落合并、受控并发、请求节流、超时与连续失败暂停。
- 可设置“不翻译末尾页数”，用于跳过参考文献。
- 🔄 可取消当前任务并按最新设置重新翻译。
- 🖨️ 可尝试将当前双语阅读结果导出为 PDF，并添加为当前文献的 Zotero 附件。

## 环境

- Zotero 10.x
- macOS 为主要测试平台
- 默认 Google 无需额外安装插件；仅选择 Translate for Zotero 兼容模式时需要先安装：
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

- 内置统一翻译引擎管理：各服务独立密钥、模型、端点、领域及测试；
- 兼容 Translate for Zotero / Ollama；
- 不翻译末尾页数；
- 最大并发请求；
- 请求启动间隔；
- 单次请求最大字符数；
- 单次合并段落数；
- 请求超时；
- 连续失败后暂停；
- 翻译缓存清理。

## 内置翻译引擎设置

在 Zotero 设置 → 中英对照 → 翻译后端，选择所需服务。免费服务可直接使用；需要 API Key 的服务必须填写各自的有效凭据。模型和端点等参数互相隔离，同一时间只使用所选服务。

**医学论文翻译建议**：优先测试 Google 以获得无需密钥的基本体验；专业医学术语可选择有道智云的“medicine”领域，或按需使用 Qwen-MT、Gemini、Claude 等服务，但应在论文关键结论、剂量、统计学方向等处人工核对。任何在线翻译都会将待翻译段落传输到外部服务，处理未发表或敏感资料时建议优先使用本地 Ollama / LibreTranslate / NLLB。

“测试此服务”会向该服务发送短句，可能产生 API 费用，不会自动测试所有服务。免费网页接口、签名 API、第三方兼容端点可能随时间改变，不保证运行时持续可用。

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

**◫ 左右对照 PDF**：打开普通 PDF 页面，点击工具栏 ◫。左侧保留原始 PDF 的矢量页面（含可见图表），右侧显示对应原页的中文重排译文。每个原页独立分页；长译文自动续页并重复左侧原页，避免裁切。未翻译段落显式标记并保留原文；跳过尾页设置仍然有效。输出为一个宽版 PDF 附件，可在 Zotero 中再次打开。该模式不是原位覆盖翻译，右侧不会复刻原文图表布局，批注/链接/签名等交互对象不保证保留。无需安装 PDF2zh 或 Python（选 Docling 才需要本地服务）。

**🖨️ 旧版逐段重排导出**：清理读者视口的固定高度、裁切与位置样式，统一 A4 边距，等待 HTML 完全加载才打印。默认附加完整原始 PDF 作为附录；如果检测到漏图，继续导出时必须保留原始 PDF 附录。附录并非将缺失 Figure 插入其正文中的正确位置。若希望减小文件，可在设置中关闭默认附录（检测到疑似漏图时仍会提示附录）。

PDF 合并后重新读取校验总页数，导入 Zotero 为新附件；不覆盖原文件。CI 包含真实打印样本的独立渲染检查。

## 内置翻译服务的注意事项

- Google 与 Bing 免密钥方案通过非官方网页翻译端点联网请求，**不是官方的有服务等级保证的 API**；可能受服务规则、网络地区、速率限制或端点调整影响。不能保证无限量或永久可用。
- 为降低限流及避免跨段错位，内置服务固定逐段串行，Google 最短请求间隔 750 毫秒，Bing 最短间隔 300 毫秒。可在设置中继续调大请求间隔。
- 文献正文会发送给所选择的在线翻译服务。敏感、未发表或受限制的数据请使用本地 Ollama 并自行核对隐私要求。
- 已经选择 Translate for Zotero / Ollama 的旧用户设置会保留；新安装默认 Google。
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
- [Translate for Zotero](https://github.com/windingwind/zotero-pdf-translate)（AGPL-3.0）：此前内置引擎分支包含参考及改编的服务适配器，保留相应源码署名和许可证。
- [ReadIN 译读](https://github.com/phoenix8701-ctrl/readin-yidu)（AGPL-3.0）：参考整页双语阅读及回存 Zotero 的交互；本次未复制代码。
- [Zotero PDF2zh](https://github.com/guaguastandup/zotero-pdf2zh)（AGPL-3.0）：参考 PDF 左右对照和附件导出设计；本次未复制其代码或调用其服务。
- [pdf-lib](https://github.com/Hopding/pdf-lib)（MIT）：实际打包依赖，用于原页复制与合并；相关第三方许可证见 addon/content/licenses/pdf-export-dependencies.txt。
