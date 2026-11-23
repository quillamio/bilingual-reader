# PDF.js 原生解析与可选 Docling 增强（v0.5.5 预览）

## PDF.js 原生模式

1. 在 Zotero 中打开原始 PDF 的普通页面视图，不必开启阅读模式。
2. 点击工具栏 📑。插件通过普通 PDF 视图中的 PDF.js PDFDocumentProxy 读取文字和页坐标，不访问 SDT #sdt-content。
3. 对提取到的段落调用当前翻译服务，复用缓存和失败暂停；图像不发送给翻译 API。
4. 每页完整原始 PDF 页面渲染为 JPEG，下一页放英文原文与中文译文，生成新的 Zotero 附件。

PDF.js 模式会保留每页所有原始可见 Figure 和表格，而非依赖 Zotero 阅读模式成功识别的图片块。

**关键限制：** 目前直接复用 Zotero 普通 PDF 视图的 PDF.js 实例，因此 PDF 必须先在 Zotero 中打开。它不依赖 SDT 阅读模式，但不是独立于整个 Zotero 阅读器的第二套 PDF.js 二进制。页面快照为 JPEG，原始页的矢量对象、可复制原始文字层和点击式注释暂不保留；新增英中译文页可复制和搜索。原始 PDF 附件绝不修改。

## Docling 本地增强（可选）

Docling 用于改进复杂双栏的阅读顺序，以及标题、图注、表格的结构识别。原始页面仍由 PDF.js 渲染，因此 Docling 解析的准确性不会决定 Figure 是否存在。

macOS 上在克隆的仓库源码目录执行：

    python3 -m venv .venv-docling
    .venv-docling/bin/python -m pip install -U pip
    .venv-docling/bin/python -m pip install docling
    .venv-docling/bin/python scripts/docling_local_server.py

在 Zotero 设置 → 中英对照 → 原始 PDF 解析中选择“Docling（本地增强）”，地址设为 http://127.0.0.1:8786，点击“测试连接”，保存。

本地服务仅绑定 127.0.0.1。插件只接受 localhost、127.0.0.1、[::1] 等 loopback URL，禁止远程公网地址。原始 PDF 仅发送至这台计算机上的本地 Python 服务，不会自行上传云端。Docling 首次运行时可能需要下载模型权重；需要离线使用时应按照官方说明提前缓存模型。

输入限制 30MB，JSON 请求包括 pdf_base64、expected_pages、ocr=false，附带 X-Bilingual-Reader 请求头。服务会返回按页组织的块和位置；如果结果不全、页数不匹配或服务没有启动，插件会提示并允许用户回退 PDF.js，而不是悄悄丢失内容。当前未包含扫描件 OCR。

## 边界与下一阶段

- PDF.js 文本行聚合与双栏阅读顺序是启发式算法；特殊排版、数学公式、复杂表格仍需真实论文验证。
- 逐页完整图像的导出比只复制阅读模式图片可靠，但 110MB 页面图像总量上限可能导致大文献显式报错；此时应先拆分原始文件。
- 新模式需要现有翻译后端可用，API 密钥、额度和联网情况不由 PDF.js 或 Docling 保证。
- 后续应将独立版本的 PDF.js 与匹配的 Worker 静态打包进 XPI，以使未打开的 Zotero 附件也可直接解析。当前没有完成这一步。
- 长期进一步用 PDF 原始页面复制代替 JPEG 快照，保留矢量图形和原始可搜索文字层。
- 发布前必须对双栏全文、Figure、图注、长表格、扫描件及数百页文件完成视觉回归，不能仅以 CI 编译成功为标准。

上游许可证：PDF.js 为 Apache-2.0；Docling 源码为 MIT。Docling 模型权重可能有独立许可要求。
