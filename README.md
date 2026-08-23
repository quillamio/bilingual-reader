<p align="center" style="font-size:72px">🀄</p>

# Zotero Bilingual Reader

Zotero Bilingual Reader 是一个面向 **Zotero 10** 的 PDF 段落中英对照阅读插件。它利用 Zotero 10 新 PDF 阅读模式中的结构化文档文本，把英文原文和中文译文按段落连续排列，适合医学、生物学及其他英文论文精读。

## v0.1.7：原生 Emoji + 更可靠的 PDF 导出

v0.1.7 主要修复两个实际使用问题：

- 阅读器不再加载外部或本地图片图标，直接使用系统 Emoji：**🀄** 表示开启 / 关闭中英对照，**🖨️** 表示导出 PDF。
- 插件管理器仍使用本地、无外部依赖的简化红中图标作为兼容回退，避免不同系统对彩色 Emoji SVG 支持不一致。
- PDF 导出不再尝试直接取得 Zotero 阅读模式内部 iframe 的 `browsingContext`；该对象在部分 Zotero 10 构建中不可访问，因此会出现“当前 Zotero 10 阅读视图不支持直接生成 PDF”。
- 新版改为调用 Zotero 自身的 `HiddenBrowser`，把当前已经生成的中英对照内容复制到一个临时隐藏打印页面，再使用 Zotero / Firefox 自身的 PDF 打印上下文生成 PDF，最后自动加入当前文献的 Zotero 条目附件。

## 主要功能

- 支持 Zotero 10.x 和 macOS。
- 读取 Zotero 10 阅读模式中的真实结构化段落，不通过空行猜测 PDF 段落。
- 对正文、标题、图注和部分注释内容逐段翻译。
- 中文译文直接显示在对应英文段落下方，并以左侧竖线区分。
- 自动跳过 Zotero 已识别的参考文献，并支持设置“不翻译末尾页数”。
- 已完成译文会缓存，重复打开论文时减少重复请求。
- 默认调用 **Translate for Zotero**；也可切换为 Ollama。
- 支持短段落批量翻译、受控并发、请求节流、超时、连续失败熔断和视口优先调度。
- 避免长时间翻译时持续访问失效阅读视图，降低 `can't access dead object` 类错误。
- 支持把当前中英对照结果导出为 PDF 条目附件。

## Zotero 设置页

安装后进入：

```text
Zotero → 设置 → 中英对照
```

阅读器顶部不再放置设置按钮，避免占用阅读空间。

### 翻译后端

```text
Translate for Zotero（默认、推荐）
Ollama（可选）
```

### Translate for Zotero

插件通过 Translate for Zotero 的公开接口调用用户已经配置好的翻译服务：

```ts
Zotero.PDFTranslate.api.translate(raw, {
  pluginID,
  itemID,
  langto: "zh-CN",
  service,
});
```

可以在本插件设置页中选择：

```text
跟随 Translate for Zotero 当前默认服务
```

或者直接指定 Translate for Zotero 已注册的翻译服务。服务本身的密钥、额度、接口地址及高级参数仍由 Translate for Zotero 管理。

Translate for Zotero：

https://github.com/windingwind/zotero-pdf-translate

### Ollama

默认地址：

```text
http://127.0.0.1:11434
```

默认模型：

```text
gpt-oss:20b
```

也可以填写其他本地模型或 Ollama Cloud 模型。

### 翻译范围

“不翻译末尾页数”默认用于避开论文尾部参考文献。设为 `0` 时不按页数排除；Zotero 已明确识别为参考文献的结构化段落仍会自动跳过。

### 速度与稳定性

插件支持：

- 最大并发请求数；
- 请求启动间隔；
- 单次请求最大字符数；
- 短段落批量数；
- 请求超时；
- 连续失败后暂停；
- 有界翻译缓存。

对于容易限流的免费网页翻译服务，建议不要盲目提高并发，而是适当增加请求间隔。

## 阅读器工具栏

PDF 阅读器顶部保留三个与本插件相关的操作：

- **🀄**：开启 / 关闭段落中英对照。
- **🔄**：取消当前任务、清除错误结果，并按照当前设置重新组织未成功译文。
- **🖨️**：将当前中英对照结果导出为 PDF，并加入当前文献的 Zotero 条目附件。

**不再显示 ⚙。** 修改翻译后端、翻译服务、范围和速度参数，请统一前往 `Zotero → 设置 → 中英对照`。

## 导出中英对照 PDF

完成部分或全部翻译后，点击阅读器顶部的 **🖨️**。

插件会：

1. 检查当前阅读模式中是否存在成功译文。
2. 如果仍有失败、暂停或正在翻译的段落，会询问是否只导出已经成功的译文。
3. 复制当前结构化阅读内容及已经成功的中文译文到 Zotero 的临时隐藏打印页面。
4. 使用 Zotero / Firefox 自身的 PDF 打印能力生成可搜索、可复制文字的 PDF。
5. 自动把生成的 PDF 导入当前文献的父级 Zotero 条目，附件标题格式为：

```text
论文标题 - 中英对照翻译
```

导出过程中，`翻译失败`、`等待翻译`、`已暂停` 等状态提示不会写入最终 PDF。

v0.1.7 不再依赖当前 Zotero 阅读模式 iframe 是否直接暴露 `browsingContext`。这正是 v0.1.6 在部分 Zotero 10 环境中点击 🖨️ 后立即提示“不支持直接生成 PDF”的原因。

注意：当前 PDF 必须已经属于一个父级文献条目。如果 PDF 是 Zotero 中没有父级文献条目的独立附件，插件会提示先创建父级条目。

## 🔄 刷新机制

Translate for Zotero 在服务失败时可能返回错误文字，同时把任务状态标记为失败。Bilingual Reader 会同时检查任务状态和错误文本，失败内容不会作为成功译文写入缓存。

点击 🔄 时：

```text
取消旧翻译任务
        ↓
移除当前译文块
        ↓
重新读取翻译后端 / 服务 / 范围 / 速度参数
        ↓
恢复当前后端真正成功的缓存
        ↓
重新翻译其余段落
```

因此切换 Translate for Zotero 的具体服务后，可以直接返回 PDF 点击 🔄 重试。

## 缓存

缓存会区分：

```text
PDF 条目
+ 翻译后端
+ Translate for Zotero 实际服务 / Ollama 地址与模型
+ 原文哈希
+ 目标语言
```

缓存采用有界策略，避免长期阅读大量论文后无限占用 Zotero 偏好存储。

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
2. 点击阅读器顶部的 **🀄**。
3. 插件自动尝试进入 Zotero 10 阅读模式。
4. 等待 Zotero 生成结构化文本。
5. 中文译文逐段显示在英文原文下方。
6. 如需重新请求，点击 **🔄**。
7. 如需保存阅读结果，点击 **🖨️** 导出为 Zotero 条目附件。

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
- PDF 导出使用 Zotero 结构化阅读内容重新排版，因此它是“可搜索的双语阅读版 PDF”，不是原始出版社 PDF 的逐像素覆盖版本。
- 某些由 Zotero 延迟加载、临时生成或受权限限制的复杂图像，在导出页面中仍可能缺失；正文和已成功译文是导出的核心内容。
- Zotero 当前没有公开“阅读模式逐段扩展接口”，插件需要访问 Zotero 10 阅读器内部结构，因此 Zotero 后续修改内部实现时可能需要适配。

## 图标说明

阅读器工具栏直接使用系统 Emoji：

```text
🀄  中英对照
🔄  重新翻译
🖨️  导出 PDF
```

不再依赖 Google Emoji 图片、外部 CDN 或 `chrome://...` 图片地址。插件管理器图标使用本地简化红中图形作为兼容回退。

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
