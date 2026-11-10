<p align="center">
  <img src="addon/content/icons/mahjong-red-dragon.svg" width="96" alt="Bilingual Reader" />
</p>

# Bilingual Reader

**Zotero 10 阅读模式 PDF 段落中英对照翻译。**

在 Zotero 10 的 PDF 阅读模式中读取结构化段落，将英文原文与中文译文按段落连续显示，适合论文精读。

> 本插件由 GPT 编写。

## 主要功能

- 🀄 一键开启 / 关闭段落中英对照。
- 默认内置 **Google 翻译（免 API Key）**，无需安装任何其他 Zotero 翻译插件。
- 内置 Google、Bing、Youdao、DeepL、百度、微软、彩云、腾讯、火山、阿里云、讯飞、有道智云等翻译服务，独立调用，无需其他 Zotero 插件。
- 支持 OpenAI 及兼容 API、Gemini、Claude、Qwen-MT、Azure OpenAI，以及 LibreTranslate、MTranServer、DeepLX 和 NLLB 等自托管服务。
- 按“免费网页 / 商业 API / 自托管”分组，单独管理各服务的密钥、模型名称、服务地址和领域配置。
- 可选 **Ollama** 本地或云端模型。
- 自动缓存已完成译文。
- 支持短段落合并、受控并发、请求节流、超时与连续失败暂停。
- 可设置“不翻译末尾页数”，用于跳过参考文献。
- 🔄 可取消当前任务并按最新设置重新翻译。
- 🖨️ 可尝试将当前双语阅读结果导出为 PDF，并添加为当前文献的 Zotero 附件。

## 环境

- Zotero 10.x
- macOS 为主要测试平台
- **默认使用 Google** 时不需要安装 Translate for Zotero，也不需要配置 API Key，但需要能够访问对应在线服务。
- 如果选择兼容模式 Translate for Zotero，需要另行安装并配置：
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

- 统一内置引擎管理界面，全部可选的段落翻译服务无需安装 Translate for Zotero；
- 按服务分别配置 API Key、端点、模型、领域和可选参数，提供短句连通测试；
- Google 为新安装默认选项，免费网页服务采用节流和单段串行请求；
- 为旧用户保留 Translate for Zotero 兼容模式（只有选择此模式才需要安装）；
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

## PDF 导出

当前导出目标是生成**重新排版的可搜索双语 PDF**，再作为附件加入当前 Zotero 文献条目。

它不是在出版社原始 PDF 页面上直接覆盖中文，因此复杂图片、延迟加载内容或特殊排版可能无法完全保留。该功能仍在持续适配 Zotero 10 的打印接口。

## 内置翻译服务的注意事项

- Google 与 Bing 免密钥方案通过非官方网页翻译端点联网请求，**不是官方的有服务等级保证的 API**；可能受服务规则、网络地区、速率限制或端点调整影响。不能保证无限量或永久可用。
- 为降低限流及避免跨段错位，内置服务固定逐段串行，Google 最短请求间隔 750 毫秒，Bing 最短间隔 300 毫秒。可在设置中继续调大请求间隔。
- 文献正文会发送给所选择的在线翻译服务。敏感、未发表或受限制的数据请使用本地 Ollama 并自行核对隐私要求。
- 已经选择 Translate for Zotero / Ollama 的旧用户设置会保留；新安装默认 Google。
- 内置段落引擎覆盖免费、商业 API、自托管三类。各厂商的账户、付费额度、官方 API 授权及实际可用性仍由厂商决定。
- 部分词典（Cambridge、Collins、Bing Dict 等）只接受单词，不适合论文全文段落翻译，故不提供段落模式。Pot 只显示外部弹窗而不会返回译文；CNKI 和 Iciba 的复杂网页鉴权仍未移植，不能算作已支持。
- API Key 分服务保存在本地 Zotero 偏好配置中，不是 macOS 钥匙串加密存储；不要共享配置文件。更换密钥或模型会自动变更缓存命名空间。
- 语言方向当前固定为英文到简体中文；部分厂商对中英文语言代码的定义不同，适配层分别转换。

## 当前限制

- 目前主要面向英文 → 简体中文。
- 表格暂不逐单元格翻译。
- 数学公式不会作为普通文本翻译。
- 扫描版 PDF 取决于 Zotero 能否生成可用文本。
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
