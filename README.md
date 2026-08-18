# Zotero Bilingual Reader

Zotero Bilingual Reader 是一个面向 Zotero 10 的 PDF 段落中英对照阅读插件。

插件不会自己维护翻译服务，而是直接调用 [Translate for Zotero](https://github.com/windingwind/zotero-pdf-translate) 提供的公开翻译接口。因此，你在 Translate for Zotero 中已经配置好的 Google 翻译、DeepL、大语言模型接口或其他翻译服务，可以直接继续使用。

本插件的主要目标不是“选中文字后翻译”，而是在 Zotero 10 新 PDF 阅读模式中，把英文原文和中文译文按段落连续排列，形成类似论文双语精读的阅读效果。

## 主要功能

- 支持 Zotero 10 PDF 阅读器。
- 支持 macOS，也可用于 Windows 和 Linux。
- 在 PDF 阅读器工具栏增加“中英”按钮。
- 点击“中英”后自动尝试进入 Zotero 10 阅读模式。
- 直接读取 Zotero 10 的结构化文档段落，而不是用空行猜测 PDF 段落。
- 对正文、标题、图注和部分注释内容逐段翻译。
- 中文译文直接显示在对应英文段落下方，并用左侧红色竖线区分。
- 自动排除 Zotero 已识别的参考文献条目。
- 翻译能力直接调用 Translate for Zotero 的当前默认翻译服务。
- 已翻译段落会进行本地缓存，重复打开同一篇论文时减少重复翻译请求。
- 再次点击“中英”可以临时关闭当前阅读页面中的译文显示。

## 运行要求

1. Zotero 10.x。
2. Translate for Zotero 已安装并启用。
3. Translate for Zotero 中至少已经配置一个可正常工作的翻译服务。

本插件本身不保存 Google、DeepL 或大语言模型的接口密钥。所有翻译服务配置仍由 Translate for Zotero 管理。

## macOS 安装方法

### 第一步：安装 Translate for Zotero

先安装并启用 Translate for Zotero：

https://github.com/windingwind/zotero-pdf-translate

安装后，进入 Translate for Zotero 的设置页面，确认翻译服务可以正常使用。

### 第二步：安装 Bilingual Reader

从本仓库的 Releases 页面下载最新版：

`bilingual-reader-*.xpi`

在 macOS 的 Zotero 10 中：

1. 打开 Zotero。
2. 进入“工具” → “插件”。
3. 点击插件管理器右上角的齿轮按钮。
4. 选择“从文件安装插件……”。
5. 选择下载好的 `.xpi` 文件。
6. 安装完成后，如 Zotero 提示重启，请重启 Zotero。

XPI 是 Zotero 插件包，不是 macOS 应用程序，因此不需要复制到“应用程序”文件夹，也不需要单独安装 `.dmg`。

## 使用方法

1. 在 Zotero 10 中打开一篇 PDF 论文。
2. 在 PDF 阅读器顶部找到“中英”按钮。
3. 点击“中英”。
4. 插件会自动尝试启用 Zotero 10 的新阅读模式。
5. Zotero 完成结构化文本加载后，插件开始逐段调用 Translate for Zotero。
6. 中文译文会直接显示在对应英文段落下面。

显示效果大致如下：

```text
We discovered that PRMT9 knockdown enhanced STAT1 phosphorylation...

┃ 我们发现，PRMT9 敲低增强了 STAT1 的磷酸化……

We further discovered that PRMT9 knockdown in THP1 cells...

┃ 我们进一步发现，在 THP1 细胞中敲低 PRMT9 后……
```

再次点击“中英”，可以移除当前阅读页面中已经插入的中文译文；缓存不会因此删除。

## 翻译服务如何选择

Bilingual Reader 不单独提供翻译服务选择器。

请直接在 Translate for Zotero 中选择你希望使用的服务。Bilingual Reader 调用：

```ts
Zotero.PDFTranslate.api.translate(raw, {
  pluginID,
  itemID,
  langto: "zh-CN",
});
```

如果没有明确传入 `service`，Translate for Zotero 会使用其当前默认翻译服务。

因此，如果你想切换 Google 翻译、DeepL 或大语言模型，只需要修改 Translate for Zotero 的设置，不需要修改 Bilingual Reader。

## Zotero 10 阅读模式实现方式

Zotero 10 的新 PDF 阅读模式使用结构化文档文本，将 PDF 内容重新组织为可以连续阅读的 HTML 结构，例如：

- 正文段落；
- 标题；
- 图注；
- 表格；
- 数学内容；
- 图片；
- 列表；
- 参考文献。

Bilingual Reader 读取阅读模式中带有 `data-ref-path` 的语义段落，再把译文插入到对应原文块之后。

这比读取整个窗口的 `innerText` 后再根据空行切段更加可靠，尤其适合双栏医学和生物学论文。

## 缓存

当前版本按照以下信息缓存译文：

- Zotero PDF 条目；
- 原文内容哈希；
- 目标语言。

如果原文没有改变，下一次打开论文时会优先读取缓存，从而减少重复翻译请求。

## 当前限制

这是早期版本，仍有以下限制：

- 当前主要针对英文论文翻译为简体中文。
- 表格单元格暂不进行逐格翻译。
- 数学公式不会作为普通文本翻译。
- 扫描版 PDF 是否可用，取决于 Zotero 结构化文本或文字识别结果。
- 当前翻译按段落依次提交，超长论文第一次全文翻译可能需要一定时间。
- Zotero 目前没有公开“阅读模式逐段扩展接口”，因此本插件需要访问 Zotero 10 阅读器内部的结构化阅读视图。Zotero 10 后续小版本如果修改内部实现，插件可能需要同步适配。

## macOS 兼容性

插件代码不依赖 Windows 注册表、Windows 路径、可执行文件或平台专用动态库。

插件的 `manifest.json` 当前限定：

```json
"strict_min_version": "10.0",
"strict_max_version": "10.*"
```

因此发布版目标为 Zotero 10.x。项目持续集成同时在 Linux 和 macOS 环境执行构建检查，以尽早发现平台相关的构建问题。

## 开发与构建

```bash
npm install
npm run build
```

构建产物由 `zotero-plugin-scaffold` 生成。

正式发布的 XPI 请优先从 GitHub Releases 下载，不建议直接使用仓库中历史遗留的手工构建文件。

## 项目结构

```text
src/
├── index.ts
├── addon.ts
├── hooks.ts
└── bilingualReader.ts
```

其中：

- `hooks.ts`：负责插件启动、关闭以及阅读器事件注册；
- `bilingualReader.ts`：负责 Zotero 10 阅读模式访问、段落识别、Translate for Zotero 调用、译文插入和缓存；
- `addon.ts`：插件实例；
- `index.ts`：插件入口。

## 许可证

AGPL-3.0-or-later。

本项目调用 Translate for Zotero 的公开接口；Translate for Zotero 本身同样采用 AGPL-3.0-or-later 许可证。