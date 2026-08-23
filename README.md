<p align="center">
  <img src="addon/content/icons/mahjong-red-dragon.svg" width="88" alt="Bilingual Reader" />
</p>

# Zotero Bilingual Reader

Zotero Bilingual Reader 是一个面向 **Zotero 10** 的 PDF 段落中英对照阅读插件。它利用 Zotero 10 新 PDF 阅读模式中的结构化文档文本，把英文原文和中文译文按段落连续排列，适合医学、生物学及其他英文论文精读。

## v0.1.6：更简洁的阅读界面 + PDF 导出

v0.1.6 主要优化阅读器界面，并新增中英对照 PDF 导出：

- 阅读器顶部不再显示 **⚙ 设置按钮**；所有翻译设置统一放在 `Zotero → 设置 → 中英对照`。
- 原来的“中英”文字按钮改为麻将红中图标：<img src="addon/content/icons/mahjong-red-dragon.svg" width="20" alt="中英对照" />。
- 新增打印机按钮：<img src="addon/content/icons/printer.svg" width="20" alt="导出 PDF" />，可把当前已经成功翻译的中英对照阅读结果导出为 PDF，并自动加入当前文献的 Zotero 条目附件中。
- 插件自身图标同步改为麻将红中图标。
- 保留 🔄 刷新按钮，用于取消旧任务、清除错误结果，并按当前设置重新翻译。

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

- <img src="addon/content/icons/mahjong-red-dragon.svg" width="20" alt="中英对照" />：开启 / 关闭段落中英对照。
- **🔄**：取消当前任务、清除错误结果，并按照当前设置重新组织未成功译文。
- <img src="addon/content/icons/printer.svg" width="20" alt="导出 PDF" />：将当前中英对照结果导出为 PDF，并加入当前文献的 Zotero 条目附件。

**不再显示 ⚙。** 修改翻译后端、翻译服务、范围和速度参数，请统一前往 `Zotero → 设置 → 中英对照`。

## 导出中英对照 PDF

完成部分或全部翻译后，点击阅读器顶部的打印机图标 <img src="addon/content/icons/printer.svg" width="20" alt="导出 PDF" />。

插件会：

1. 检查当前阅读模式中是否存在成功译文。
2. 如果仍有失败、暂停或正在翻译的段落，会询问是否只导出已经成功的译文。
3. 使用 Zotero 10 / Firefox 自带的 PDF 打印能力，把当前阅读模式中的英文原文和成功中文译文生成 PDF。
4. 自动把生成的 PDF 导入当前文献的父级 Zotero 条目，附件标题格式为：

```text
论文标题 - 中英对照翻译
```

导出过程中，`翻译失败`、`等待翻译`、`已暂停` 等状态提示不会写入最终 PDF。

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
2. 点击阅读器顶部的 <img src="addon/content/icons/mahjong-red-dragon.svg" width="20" alt="中英对照" />。
3. 插件自动尝试进入 Zotero 10 阅读模式。
4. 等待 Zotero 生成结构化文本。
5. 中文译文逐段显示在英文原文下方。
6. 如需重新请求，点击 🔄。
7. 如需保存阅读结果，点击 <img src="addon/content/icons/printer.svg" width="20" alt="导出 PDF" /> 导出为 Zotero 条目附件。

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
- PDF 导出基于当前 Zotero 阅读模式页面；尚未加载的复杂图像区域可能仍受 Zotero 阅读模式自身的延迟加载机制影响。
- Zotero 当前没有公开“阅读模式逐段扩展接口”，插件需要访问 Zotero 10 阅读器内部结构，因此 Zotero 后续修改内部实现时可能需要适配。

## 图标来源

麻将红中与打印机图标使用 Google Noto Emoji 图形并本地打包，避免阅读器联网加载图标。Google Noto Emoji 使用 Apache License 2.0。

用户指定的视觉参考：

- https://em-content.zobj.net/source/google/298/mahjong-red-dragon_1f004.png
- https://em-content.zobj.net/source/google/298/printer_1f5a8-fe0f.png

官方图形来源：

- https://github.com/googlefonts/noto-emoji/blob/main/svg/emoji_u1f004.svg
- https://github.com/googlefonts/noto-emoji/blob/main/svg/emoji_u1f5a8.svg

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
