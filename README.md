# Zotero Bilingual Reader

Zotero Bilingual Reader 是一个面向 Zotero 10 的 PDF 段落中英对照阅读插件。它利用 Zotero 10 新 PDF 阅读模式中的结构化文档文本，把英文原文和中文译文按段落连续排列，适合医学、生物学及其他英文论文精读。

## v0.1.5 兼容性修复与重点改进

v0.1.5 修复 v0.1.4 在 Zotero 10 插件沙箱中使用不可用的全局 `AbortController`，导致翻译立即失败的问题。阅读器工具栏的 ⚙ 按钮现在会直接打开 Zotero 的“中英对照”设置页，可以选择 Translate for Zotero 或 Ollama，并设置末尾不翻译页数（默认 1 页）。

同时保留 v0.1.4 的长期运行内存控制与 Translate for Zotero 调用速度优化：

1. **Zotero 兼容的可取消任务与请求超时**：使用插件自有取消令牌，不依赖 Zotero 沙箱未提供的 `AbortController`。关闭双语模式、点击 🔄、关闭 Reader 或卸载插件时，会立即终止本地调度并释放 Reader/DOM 引用；Translate for Zotero 没有公开取消 API，因此已经发出的底层请求可能自行结束，但不再持有本插件的阅读视图。
2. **短段落批量翻译**：默认在 2800 字符上限内合并最多 6 个短段落，一次调用 Translate for Zotero。结果必须完整保留分段标记，否则自动逐段重试，确保不会错位。
3. **视口优先**：优先翻译当前正在阅读的位置，再向前后扩展，首屏更快出现译文。
4. **有界缓存**：缓存最多保留 1500 段或约 600 万字符，并按最近使用淘汰；设置页可以一键清理。
5. **偏好迁移**：自动修复 v0.1.3 重复写入 `extensions.zotero.` 前缀的问题，保留旧设置与可复用译文。

同时增加：

- Translate for Zotero / Ollama 两种后端切换；
- 可直接指定 Translate for Zotero 的具体服务，或跟随其当前默认服务；
- Ollama 地址、模型设置与连接测试；
- 段落请求间隔、连续失败阈值设置；
- 新的 v2 缓存命名空间，会区分翻译后端、Translate for Zotero 指定服务以及 Ollama 模型；
- 兼容清理 v0.1.1 中可能被错误缓存的 `[请求错误]`、`此翻译服务不可用`、`Request error` 等错误文本。

## 主要功能

- 支持 Zotero 10.x 和 macOS。
- 读取 Zotero 10 阅读模式中的真实结构化段落，不通过空行猜测 PDF 段落。
- 对正文、标题、图注和部分注释内容逐段翻译。
- 中文译文直接显示在对应英文段落下方，并以左侧竖线区分。
- 自动跳过 Zotero 已识别的参考文献。
- 已完成译文会缓存，重复打开论文时减少重复请求。
- 支持 Translate for Zotero 和 Ollama。
- 支持请求节流和连续失败熔断。
- 避免长时间翻译时因 Zotero 阅读视图重建而持续访问失效 DOM，降低 `can't access dead object` 错误。

## Zotero 设置页

安装 v0.1.5 后，进入：

```text
Zotero → 设置 → 中英对照
```

可以配置以下内容。

### 翻译后端

```text
Translate for Zotero
Ollama
```

### Translate for Zotero

插件会通过 Translate for Zotero 官方公开接口：

```ts
Zotero.PDFTranslate.api.translate(raw, {
  pluginID,
  itemID,
  langto: "zh-CN",
  service,
});
```

在设置页可以选择：

```text
跟随 Translate for Zotero 当前默认服务
```

或者直接指定 Translate for Zotero 已注册的某一个翻译服务。

服务本身的密钥、额度、接口地址和高级参数仍由 Translate for Zotero 管理。

### Ollama

默认地址：

```text
http://127.0.0.1:11434
```

默认模型：

```text
gpt-oss:20b
```

也可以使用其他已安装模型或 Ollama Cloud 模型，例如：

```text
gpt-oss:120b-cloud
```

设置页提供 **测试 Ollama 连接** 按钮，会请求：

```text
GET /api/tags
```

翻译时调用：

```text
POST /api/chat
```

### 翻译范围

“不翻译末尾页数”默认为 `1`，按 PDF 物理页跳过最后一页，常用于避开论文末尾参考文献。设为 `0` 时不按页数跳过；Zotero 已明确标记为参考文献的结构化段落仍会自动排除。

### 稳定性参数

默认段落请求启动间隔：

```text
250 ms
```

如果使用容易限流的免费网页翻译服务，可以适当提高到：

```text
800–1200 ms
```

默认连续失败：

```text
3 次
```

达到阈值后自动暂停剩余段落，避免一个失效服务连续请求整篇论文。

## 工具栏按钮

PDF 阅读器顶部显示：

- **中英**：开启 / 关闭段落中英对照。
- **🔄**：取消当前任务，移除当前页面中的旧译文块，然后按当前设置重新整理译文。
- **⚙**：直接打开 Zotero“中英对照”设置页，选择 Translate for Zotero / Ollama 及翻译范围。

## 🔄 在 v0.1.2 中如何工作

旧版本存在一个关键问题：Translate for Zotero 的公开 API 在服务请求失败时，可能返回：

```text
status = "fail"
result = "[请求错误] ..."
```

如果只判断 `result` 是否为空，就会错误地把报错文字当成“成功译文”写入缓存。之后即使换了翻译服务，再点击 🔄，插件仍然从缓存加载同一段错误文字。

v0.1.2 改为：

```text
Translate for Zotero 返回任务
        ↓
检查 task.status
        ↓
status = success
        ↓
才允许写入缓存

status = fail
        ↓
显示失败提示
        ↓
绝不写入成功缓存
```

点击 🔄 时：

```text
取消旧翻译任务
        ↓
移除当前所有中文译文块
        ↓
重新读取当前翻译后端 / 服务 / 模型
        ↓
恢复该后端真正成功的缓存
        ↓
重新翻译其余段落
```

因此，如果必应失效后改成 DeepL、Google、其他 Translate for Zotero 服务或 Ollama，点击 🔄 后旧错误提示应立即消失，并由新的翻译结果替换。

## 缓存

v0.1.2 使用新的缓存命名空间，主要包含：

```text
PDF 条目
+ 翻译后端
+ Translate for Zotero 指定服务 / Ollama 地址与模型
+ 原文哈希
+ 目标语言
```

因此：

- Translate for Zotero → Ollama：不会误用旧后端译文；
- Ollama 更换模型：使用新的缓存；
- Translate for Zotero 指定另一个服务：使用新的缓存；
- 同一后端、同一模型和同一段落：继续利用已有成功缓存。

## 安装要求

### 使用 Translate for Zotero

需要：

- Zotero 10.x；
- Translate for Zotero 已安装并启用；
- 至少一个可正常工作的翻译服务。

Translate for Zotero：

https://github.com/windingwind/zotero-pdf-translate

### 使用 Ollama

如果选择 Ollama，翻译过程不依赖 Translate for Zotero。

在 macOS 上安装并启动 Ollama 后，将地址与模型填写到：

```text
Zotero → 设置 → 中英对照
```

然后点击 **测试 Ollama 连接**。

## macOS 安装方法

从本仓库 Releases 下载最新版：

```text
bilingual-reader-*.xpi
```

在 Zotero 10 中：

1. 打开“工具” → “插件”。
2. 点击右上角齿轮。
3. 选择“从文件安装插件……”。
4. 选择 `.xpi` 文件。
5. 如 Zotero 提示重启，请重启。

XPI 是 Zotero 插件包，不是 macOS 应用程序，不需要拖入“应用程序”文件夹。

## 使用方法

1. 在 Zotero 10 打开英文 PDF。
2. 点击阅读器顶部 **中英**。
3. 插件自动尝试进入 Zotero 10 阅读模式。
4. 等待 Zotero 生成结构化文本。
5. 中文译文逐段显示在英文原文下方。

显示效果：

```text
We discovered that PRMT9 knockdown enhanced STAT1 phosphorylation...

┃ 我们发现，PRMT9 敲低增强了 STAT1 的磷酸化……

We further discovered that PRMT9 knockdown in THP1 cells...

┃ 我们进一步发现，在 THP1 细胞中敲低 PRMT9 后……
```

## 当前限制

- 当前主要针对英文论文翻译为简体中文。
- 表格暂不逐单元格翻译。
- 数学公式不会作为普通文本翻译。
- 扫描版 PDF 是否可用取决于 Zotero 的结构化文本 / 文字识别结果。
- 第一次翻译长论文仍需要时间；当前以单请求串行方式运行，优先保证稳定性。
- Zotero 当前没有公开“阅读模式逐段扩展接口”，因此插件需要访问 Zotero 10 阅读器内部的结构化阅读视图。Zotero 后续修改内部实现时可能仍需适配。

## macOS 兼容性

插件不依赖 Windows 注册表、Windows 路径或平台专用动态库。

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
