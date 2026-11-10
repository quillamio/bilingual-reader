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
- 内置 **Bing 翻译** 和 Google 备用入口；仍可切换到 **Translate for Zotero** 的其他翻译服务。
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

- 内置 Google 翻译、Google 备用入口、Bing 翻译 / Translate for Zotero / Ollama；
- 内置免费服务不需要 API Key、采用单段串行请求；Translate for Zotero 兼容模式跟随其当前默认服务；
- 不翻译末尾页数；
- 最大并发请求；
- 请求启动间隔；
- 单次请求最大字符数；
- 单次合并段落数；
- 请求超时；
- 连续失败后暂停；
- 翻译缓存清理。

## PDF 导出

当前导出目标是生成**重新排版的可搜索双语 PDF**，再作为附件加入当前 Zotero 文献条目。

它不是在出版社原始 PDF 页面上直接覆盖中文，因此复杂图片、延迟加载内容或特殊排版可能无法完全保留。该功能仍在持续适配 Zotero 10 的打印接口。

## 内置翻译服务的注意事项

- Google 与 Bing 免密钥方案通过非官方网页翻译端点联网请求，**不是官方的有服务等级保证的 API**；可能受服务规则、网络地区、速率限制或端点调整影响。不能保证无限量或永久可用。
- 为降低限流及避免跨段错位，内置服务固定逐段串行，Google 最短请求间隔 750 毫秒，Bing 最短间隔 300 毫秒。可在设置中继续调大请求间隔。
- 文献正文会发送给所选择的在线翻译服务。敏感、未发表或受限制的数据请使用本地 Ollama 并自行核对隐私要求。
- 已经选择 Translate for Zotero / Ollama 的旧用户设置会保留；新安装默认 Google。
- 本次集成的内置引擎为 Google、Google 备用入口、Bing。Translate for Zotero 其余 20+ 引擎仍通过兼容模式使用，不应误认为已经全部独立移植。

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

AGPL-3.0-or-later。内置 Google / Bing 适配器参考并改编自
[windingwind/zotero-pdf-translate](https://github.com/windingwind/zotero-pdf-translate)
的 `src/modules/services/google.ts` 与 `bing.ts`（AGPL-3.0）；保留上游署名及许可证提示。
