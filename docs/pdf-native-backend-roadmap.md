# 独立 PDF 解析引擎：技术路线与验收标准

## 现有实现的问题

当前插件从 Zotero 10 的 SDT 阅读模式读取 `#sdt-content`，并用 `cloneNode(true)` 打印为新的中英对照 PDF。因此：

1. 阅读模式根本没有识别的 Figure 不可能被 DOM 克隆重新生成。
2. Canvas 的绘制像素不会随 `cloneNode()` 保存，Blob URL 在打印所用的 HiddenBrowser 中可能失效。
3. HTML 不是原始 PDF 的绘制模型；重排会改变图表、表格和页边界。
4. 将长译文块设为 `break-inside: avoid-page` 可能导致大面积分页空白。

本 PR 的导出热修复只解决已存在于阅读 DOM 的资源持久化与跨页问题。不要将其称为“所有 PDF 插图已恢复”。

## 建议的双引擎结构

```text
Zotero 附件（本地原始 PDF）
             |
       PDF 输入适配层
             |
    ┌────────┴─────────────────┐
    │                          │
PDF.js 原生适配器        Docling 本地服务（可选）
无 SDT 依赖                 Python / 模型独立安装
提取文字+原始几何坐标      多栏/表格/公式/图注识别
页面渲染/区域裁剪         图像与图注结构化关联
    │                          │
    └────────┬─────────────────┘
             |
       NormalizedDocument
             |
       翻译调度与缓存
             |
    ┌────────┴─────────────────┐
    │                          │
双语重排 HTML/PDF           原版保真 PDF 模式
逐段英中显示                保留原始页并附中文译文页
可选嵌入 Figure 裁图        不牺牲原图/矢量图形
```

## 中间数据模型（应首先定义，不依赖任何解析工具）

```typescript
type BlockType = "heading" | "paragraph" | "caption" | "figure" |
                 "table" | "equation" | "footnote";
interface NormalizedBlock {
  id: string;
  pageIndex: number; // 0-based
  bbox: [number, number, number, number]; // 原 PDF 坐标
  type: BlockType;
  readingOrder: number;
  sourceText?: string;
  assetRef?: string; // PNG/JPEG/SVG/区域图像的资源 ID
  captionBlockID?: string;
  confidence?: number;
}
interface NormalizedDocument {
  pages: { width: number; height: number }[];
  blocks: NormalizedBlock[];
  assets: Record<string, { mime: string; bytes?: Uint8Array }>;
}
```

## 首选：PDF.js 原生模式（不需要 Zotero 阅读模式）

- 直接从当前 Zotero 附件读取原始 PDF 字节。
- 使用 Mozilla PDF.js 的 `getTextContent()` 取得文本和坐标，用版面规则聚合为段落及双栏顺序。
- 通过同一 PDF.js 页渲染器得到 Figure 的页面区域图像；不要仅依赖 PDF 的 `getImages` 嵌入图片列表，因为多数科学图由矢量路径、字体及位图混合构成。
- 为图片和图注建立页面、坐标与邻接关系；有歧义则输出「需要人工检查」，不要静默丢图或错误合并。
- UI 使用插件独立的阅读器 iframe / 侧边栏；与 Zotero SDT 的 `_primarySDTView` 解耦。
- 中文译文沿用现有后端、缓存、节流和任务取消模型。
- 输出两种模式：双语重排（段落交错）与原版保真（原始 PDF 页面完整保留、对应中文译文作为后续页/附件）。先实施更易保证不丢图的原版保真模式。

**限制：** PDF.js 不是现成的“PDF → 语义 Markdown”工具，长表格、复杂公式、双栏阅读顺序需额外算法与测试。

## 可选增强：Docling

- GitHub: https://github.com/docling-project/docling
- MIT 许可，支持 PDF 结构化解析、布局、阅读顺序、表格、图像和图注，支持离线处理。
- 该项目使用 Python 与模型权重，**不能直接将整个 Python 解析器塞进 XPI 后就无安装地运行**。
- 应设计为用户可选的本地 CLI / loopback 服务，提供清晰安装和卸载路径；不得未经同意上传受版权或保密保护的文献到第三方。
- 对科研 PDF，图像资产应使用独立原始图像或页面区域裁图，且总是同时保存源页索引与 bbox 供质控。

其它项目：MinerU 很强，但当前仓库使用自定义 MinerU 开源许可证，必须单独核对义务；Marker 的代码与模型权重存在不同许可证条件；PyMuPDF 为 AGPL/商业双许可证。商业或开源分发前需分别审核。

## 发布前验收测试（不要仅检查生成成功）

### 分页
- 5–10 页的长论文段落：不应有遮挡正文的大白块。
- 表格跨页时每行不被切成半行；超长行超出一页则提示或分拆。
- A4 MediaBox/CropBox 正确，所有可见文字 bbox 在纸张内。
- 114 页 Pringle 故障 PDF：原有文本完整，不出现负坐标裁切。

### 图像
- PNG/JPEG、Base64、Blob URL、SVG、Canvas、PDF 原始矢量 Figure、表格及图注分别测试。
- 计算预期 Figure 数和生成 Figure 数，不能静默遗漏。
- 二栏 Figure、通栏 Figure、跨页 Figure、包含坐标轴和文字的 SCI 图。
- 不能被准确解析的图，必须保留原始 PDF 页面作为无损兜底。
- 禁止把用户原始 PDF / 翻译结果上传到任何未明确授权的云服务。

### 实际功能与质量
- 长文章图文顺序与原论文对应。
- OCR 扫描版必须显示「OCR 结果待检查」；没有 OCR 时不要臆造正文。
- macOS Zotero 10 主流版本下验证 20/100 页内存、速度、取消/恢复、缓存隔离。
- 两种导出方式都具备抽样自动视觉回归（保存渲染 PNG 与对照指标）。

## 提示

PR #21 已尝试按 Zotero SDT 图注定位并回填原 PDF 图片区域，但它依赖 Zotero 内部 PDF renderer，且只覆盖可从图注推断的图。该 PR 不能替代独立 PDF 解析模式，建议作为 opt-in 实验方案单独验证，不应无测试直接合并。
