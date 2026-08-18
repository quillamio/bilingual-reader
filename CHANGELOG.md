# 更新日志

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
