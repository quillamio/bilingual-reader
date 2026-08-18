# Zotero Bilingual Reader

Zotero Bilingual Reader 是一个面向 Zotero 10 的 PDF 段落中英对照阅读插件。它利用 Zotero 10 新 PDF 阅读模式中的结构化文档文本，把英文原文和中文译文按段落连续排列，适合论文精读。

从 v0.1.1 开始，插件支持两种翻译后端：

1. **Translate for Zotero**：继续使用你已经配置好的翻译服务。
2. **Ollama**：插件直接调用本机 Ollama 接口，可使用本地模型，也可使用 Ollama Cloud 模型。

## 主要功能

- 支持 Zotero 10.x 和 macOS。
- 读取 Zotero 10 阅读模式中的真实结构化段落，不再通过空行猜测 PDF 段落。
- 对正文、标题、图注和部分注释内容逐段翻译。
- 中文译文直接显示在对应英文段落下方，并用左侧红色竖线区分。
- 自动跳过 Zotero 已识别的参考文献。
- 已完成译文会缓存，重复打开论文时减少重复请求。
- 增加请求节流，避免连续高速调用公共翻译服务。
- 连续失败 3 次后自动暂停，防止一个失效服务把整篇论文全部刷成错误信息。
- 修复长时间翻译时因 Zotero 阅读视图重建而出现的 `can't access dead object` 问题：异步翻译不再长期持有旧的阅读器 DOM 节点，而是在写入结果前重新定位当前段落。

## 工具栏按钮

打开 PDF 后，阅读器顶部会显示三个按钮：

- **中英**：开启或关闭段落中英对照。
- **🔄**：取消当前翻译任务，删除“失败 / 正在翻译 / 已暂停”的结果，并使用当前翻译引擎重新翻译这些段落。已经成功并缓存的译文不会被删除。
- **⚙**：选择翻译后端，并配置 Ollama 地址与模型。

如果必应、有道等服务突然失效，推荐操作顺序是：

1. 在 Translate for Zotero 中切换到新的可用服务，或点击 **⚙** 改用 Ollama。
2. 回到论文阅读界面。
3. 点击 **🔄**。
4. 插件会停止旧任务，去掉失败结果，并使用新的翻译后端继续翻译。

## 安装要求

### 使用 Translate for Zotero

需要：

- Zotero 10.x；
- Translate for Zotero 已安装并启用；
- Translate for Zotero 中至少有一个可正常工作的翻译服务。

Translate for Zotero：

https://github.com/windingwind/zotero-pdf-translate

Bilingual Reader 调用其公开接口：

```ts
Zotero.PDFTranslate.api.translate(raw, {
  pluginID,
  itemID,
  langto: "zh-CN",
});
```

插件每次发起新请求时都会读取 Translate for Zotero 当前默认服务。因此切换服务后，点击 **🔄** 即可让失败段落使用新服务重新翻译。

### 使用 Ollama

使用 Ollama 时，Translate for Zotero 不再是翻译必需项。

先在 macOS 安装并启动 Ollama，然后确认本地接口可以访问：

```text
http://127.0.0.1:11434
```

在 Bilingual Reader 中点击 **⚙**：

```text
2 = Ollama
```

默认地址：

```text
http://127.0.0.1:11434
```

本地模型推荐从较小模型开始，例如：

```text
gpt-oss:20b
```

如果使用 Ollama Cloud，也可以填写：

```text
gpt-oss:120b-cloud
```

插件会直接请求：

```text
POST /api/chat
```

并要求模型只返回简体中文译文，同时保留基因、蛋白、药物、数字、单位、图表编号和参考文献标记。

## 为什么 v0.1.1 更稳定

v0.1.0 的主要问题是一次打开论文后会持续逐段请求翻译服务，并长期保存段落 DOM 对象。如果翻译期间 Zotero 切换阅读模式、刷新结构化页面、关闭 PDF 或重新创建内部 iframe，旧对象会失效，随后可能出现：

```text
can't access dead object
```

v0.1.1 做了以下修改：

- 每个翻译任务拥有独立的运行代号；点击 **🔄**、关闭双语模式或关闭阅读器都会使旧任务立即失效。
- 异步请求完成后，不直接操作旧 DOM 节点，而是根据 Zotero 的 `data-ref-path` 重新查找当前段落和译文块。
- 如果阅读模式已经被替换，旧任务直接停止，不再继续写入失效对象。
- 每个请求之间默认间隔约 650 毫秒，降低公共免费翻译服务触发限流的概率。
- 连续 3 个段落失败后触发熔断，剩余段落显示“已暂停”，等待用户切换服务后点击 **🔄**。

## macOS 安装方法

从本仓库 Releases 下载最新版：

```text
bilingual-reader-*.xpi
```

然后在 Zotero 10 中：

1. 打开“工具” → “插件”。
2. 点击右上角齿轮。
3. 选择“从文件安装插件……”。
4. 选择 `.xpi` 文件。
5. 如 Zotero 提示重启，请重启。

XPI 是 Zotero 插件包，不是 macOS 应用程序，不需要拖入“应用程序”文件夹，也不需要 `.dmg`。

## 使用方法

1. 在 Zotero 10 打开英文 PDF。
2. 点击阅读器顶部 **中英**。
3. 插件自动尝试进入 Zotero 10 阅读模式。
4. 等待 Zotero 生成结构化文本。
5. 中文译文会逐段出现在英文原文下面。

显示效果：

```text
We discovered that PRMT9 knockdown enhanced STAT1 phosphorylation...

┃ 我们发现，PRMT9 敲低增强了 STAT1 的磷酸化……

We further discovered that PRMT9 knockdown in THP1 cells...

┃ 我们进一步发现，在 THP1 细胞中敲低 PRMT9 后……
```

## 缓存

当前缓存依据：

- Zotero PDF 条目；
- 原文内容哈希；
- 目标语言。

**🔄 只清除失败、等待和暂停状态，不删除已经成功缓存的译文。**

## 当前限制

- 当前主要针对英文论文翻译为简体中文。
- 表格暂不逐单元格翻译。
- 数学公式不会作为普通文本翻译。
- 扫描版 PDF 是否可用取决于 Zotero 的结构化文本 / 文字识别结果。
- 第一次翻译长论文仍需要时间；插件目前采用单请求串行 + 节流，而不是一次把整篇论文发送给服务。
- Zotero 当前没有公开“阅读模式逐段扩展接口”，因此插件仍需要访问 Zotero 10 阅读器内部的结构化阅读视图。Zotero 10 后续版本改变内部实现时可能需要适配。
- macOS 系统自带的 Apple Translation Framework 不能直接从 Zotero 的 JavaScript 插件环境稳定调用；如果需要完全本地、离线且不依赖公共翻译接口，当前更推荐 Ollama 本地模型。

## macOS 兼容性

插件不依赖 Windows 注册表、Windows 路径、独立可执行文件或平台专用动态库。

`manifest.json` 限定：

```json
"strict_min_version": "10.0",
"strict_max_version": "10.*"
```

持续集成同时在 Linux 与 macOS 环境执行构建检查。

## 开发与构建

```bash
npm install
npm run build
```

正式 XPI 请优先从 GitHub Releases 下载。

## 许可证

AGPL-3.0-or-later。
