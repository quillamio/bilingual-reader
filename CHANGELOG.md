# 更新日志

## v0.1.9

- 插件图标替换为 Google Noto Emoji 麻将红中图标，并继续本地打包，避免运行时依赖外部图片。
- Zotero `设置 → 中英对照` 页面顶部显示同一红中图标。
- 设置页图标使用插件自身 `rootURI` 定位资源，避免 Zotero 偏好设置文档中的相对路径解析错误。
- README 大幅精简，并在顶部显示新图标。
- README 增加“本插件由 GPT 编写”说明。

## v0.1.8

- 插件 description 更新为“Zotero 10 阅读模式 PDF 段落中英对照翻译”。
- 插件元数据增加 `translation`、`reader`、`ai` 关键词，为插件商店收录准备检索信息。
- 修复点击 🖨️ 导出时出现 `Cannot modify properties of a WrappedNative`：移除已不属于当前 `nsIPrintSettings` 的 `printToFile` 扩展属性，只使用 `outputDestination`、`outputFormat` 与 `toFileName` 等受支持打印设置。
- 保留 Zotero HiddenBrowser 双语 HTML → PDF → 当前条目附件的导出流程。

## v0.1.7

- 阅读器工具栏不再加载图片图标，直接使用系统 Emoji：`🀄` 表示中英对照，`🖨️` 表示导出 PDF。
- 插件管理器图标改为本地简化红中图形，避免复杂彩色 Emoji SVG 在部分 Zotero / macOS 环境中无法显示。
- 修复 v0.1.6 点击 🖨️ 后提示“当前 Zotero 10 阅读视图不支持直接生成 PDF”的问题：不再直接读取阅读模式内部 iframe 的 `browsingContext`。
- PDF 导出改为使用 Zotero 自带 `HiddenBrowser({ useHiddenFrame: false })` 创建临时隐藏打印页面，再调用其真实 `browsingContext.print()` 生成 PDF。
- 导出内容从当前 `#sdt-content` 克隆，自动移除失败、暂停、等待等未成功译文，并使用独立 A4 打印样式重新排版。
- 生成后的 PDF 仍通过 `Zotero.Attachments.importFromFile()` 自动保存为当前文献的子附件。
- v0.1.7 已通过 ESLint、Linux 构建、macOS 构建和 Zotero 插件测试。

## v0.1.6

- 阅读器工具栏取消 ⚙ 设置按钮，翻译后端、服务、范围和速度参数统一在 `Zotero → 设置 → 中英对照` 管理。
- “中英”文字按钮改为麻将红中图标，并同步作为插件图标使用；图标本地打包，避免阅读时依赖外部网络。
- 新增打印机按钮，可把当前阅读模式中已经成功生成的英文原文 + 中文译文打印为 PDF。
- 导出前如果仍有失败、暂停或正在翻译的段落，会询问是否仅导出已经成功的双语内容；错误状态提示不会进入最终 PDF。
- 生成的 PDF 自动通过 `Zotero.Attachments.importFromFile()` 保存为当前文献的子附件，标题为“论文标题 - 中英对照翻译”。
- PDF 导出使用 Zotero / Firefox 自带打印到 PDF 能力，避免把整篇论文先栅格化成图片。
- README 同步更新新图标、工具栏布局与 PDF 导出说明。

## v0.1.5

- 修复 Zotero 10 插件沙箱没有全局 `AbortController` 时翻译立即失败的问题，改用插件自有的轻量取消令牌。
- 阅读器工具栏的 ⚙ 按钮现在直接打开 Zotero“中英对照”设置页；保留旧弹窗作为无法打开设置页时的兜底。
- 确认并回归测试 Translate for Zotero / Ollama 后端选择与保存逻辑。
- 确认并回归测试“末尾不翻译页数”，默认值为 1 页。
- 新增真实 Zotero 设置页加载、设置保存、两种翻译后端和末尾页跳过的集成测试。

## v0.1.4

- 修复已限定的偏好设置键被 Zotero 再次添加 `extensions.zotero.` 前缀的问题，并自动迁移 v0.1.3 的旧设置与缓存。
- 为运行任务增加可取消信号和请求超时；关闭、刷新或卸载插件后，本插件不再等待失效请求才释放 Reader/DOM 引用。
- 在字符上限内默认合并最多 6 个短段落调用 Translate for Zotero，严格校验分段标记，标记损坏时安全回退为逐段翻译。
- 所有实际翻译调用统一经过全局启动间隔，长段落拆分和批量回退也不会绕过限流。
- 优先翻译当前视口附近段落，并把反复全 DOM 扫描改为本次运行内的直接节点引用。
- 缓存升级为有上限的 v4 LRU 索引，默认最多 1500 段或约 600 万字符，并增加一键清理入口。
- 缓存键跟踪 Translate for Zotero 当前真实默认服务，切换默认服务后不再误用旧服务译文。
- 设置页仅列出句子翻译服务，防止误选词典后端；Ollama 连接测试会阻止重复点击并在完成后恢复。
- 新增分段、批量打包和批量结果校验单元测试。

## v0.1.3

- 增加末尾页跳过、并发数、请求间隔、字符上限等设置。
- Translate for Zotero 使用受控并发调度，超长段落按句子拆分。
- 修复设置页在 Zotero 10 中的注册和布局。

## v0.1.2

- 正式注册 Zotero 插件设置页。
- 检查 Translate for Zotero 任务状态，避免把错误文本写入成功缓存。
- 刷新时清理当前阅读视图中的旧译文块。

## v0.1.1

- 增加 🔄 恢复按钮：取消旧翻译任务，清除失败、等待和暂停状态，并使用当前翻译引擎重新翻译失败段落。
- 增加 ⚙ 翻译后端设置：可在 Translate for Zotero 与 Ollama 之间切换。
- 增加直接 Ollama `/api/chat` 支持，可使用本地模型或 Ollama Cloud 模型。
- 修复长篇翻译时可能出现的 `can't access dead object`：异步请求完成后根据 Zotero `data-ref-path` 重新定位当前段落，不再操作失效的旧 DOM 节点。
- 增加每次请求约 650 ms 的节流。
- 连续 3 个段落翻译失败后自动暂停，防止失效翻译服务造成大量错误请求。
- macOS、Linux 构建、代码检查和插件启动测试均通过后发布。

## v0.1.0

- 首个可用版本。
- 支持 Zotero 10 新 PDF 阅读模式的段落中英对照。
- 直接调用 Translate for Zotero 公开翻译接口。
