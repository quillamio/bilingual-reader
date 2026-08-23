const PLUGIN_ID = "bilingual-reader@zotero.local";
const TRANSLATION_CLASS = "bilingual-reader-translation";
const TOGGLE_BUTTON_CLASS = "bilingual-reader-toolbar-button";
const SETTINGS_BUTTON_CLASS = "bilingual-reader-settings-button";
const EXPORT_BUTTON_CLASS = "bilingual-reader-export-button";
const EXPORT_PRINT_STYLE_ID = "bilingual-reader-export-print-style";
const MAHJONG_ICON = "chrome://bilingualreader/content/icons/mahjong-red-dragon.svg";
const PRINTER_ICON = "chrome://bilingualreader/content/icons/printer.svg";

function getInternalReader(reader: any): any {
  return reader?._internalReader || reader;
}

function getActiveSDTView(reader: any): any {
  const internal = getInternalReader(reader);
  if (!internal) return null;
  const primary = internal._lastViewPrimary !== false || !internal._secondaryView;
  return primary ? internal._primarySDTView : internal._secondarySDTView;
}

function getSDTDocument(reader: any): Document | null {
  try {
    const view = getActiveSDTView(reader);
    return view?._iframeDocument || view?._iframe?.contentDocument || null;
  } catch (_) {
    return null;
  }
}

function getSDTBrowsingContext(reader: any): any | null {
  try {
    const view = getActiveSDTView(reader);
    return (
      view?._iframe?.browsingContext ||
      view?._iframe?.contentWindow?.browsingContext ||
      null
    );
  } catch (_) {
    return null;
  }
}

function getDialogWindow(reader: any): any {
  try {
    return reader?._iframeWindow || Zotero.getMainWindow();
  } catch (_) {
    return Zotero.getMainWindow();
  }
}

function showMessage(reader: any, message: string): void {
  const win = getDialogWindow(reader);
  if (win?.alert) {
    win.alert(message);
    return;
  }
  Zotero.logError(new Error(message));
}

function confirmMessage(reader: any, message: string): boolean {
  const win = getDialogWindow(reader);
  return win?.confirm ? Boolean(win.confirm(message)) : true;
}

function createToolbarImageButton(
  doc: Document,
  className: string,
  iconURL: string,
  title: string,
  onClick: (button: HTMLButtonElement) => void,
): HTMLButtonElement {
  const button = doc.createElement("button");
  button.className = `toolbar-button ${className}`;
  button.type = "button";
  button.tabIndex = -1;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.style.minWidth = "34px";
  button.style.paddingInline = "5px";

  const image = doc.createElement("img");
  image.src = iconURL;
  image.alt = "";
  image.draggable = false;
  image.width = 20;
  image.height = 20;
  image.style.display = "block";
  image.style.margin = "auto";
  image.style.pointerEvents = "none";
  button.append(image);

  button.addEventListener("click", (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick(button);
  });
  return button;
}

function replaceToggleLabelWithIcon(doc: Document): void {
  const button = doc.querySelector(`.${TOGGLE_BUTTON_CLASS}`) as HTMLButtonElement | null;
  if (!button || button.dataset.bilingualReaderIcon === "mahjong") return;

  const image = doc.createElement("img");
  image.src = MAHJONG_ICON;
  image.alt = "";
  image.draggable = false;
  image.width = 20;
  image.height = 20;
  image.style.display = "block";
  image.style.margin = "auto";
  image.style.pointerEvents = "none";

  button.replaceChildren(image);
  button.dataset.bilingualReaderIcon = "mahjong";
  button.title = "开启/关闭中英段落对照";
  button.setAttribute("aria-label", "开启/关闭中英段落对照");
}

function removeReaderSettingsButton(doc: Document): void {
  const settingsButton = doc.querySelector(`.${SETTINGS_BUTTON_CLASS}`);
  settingsButton?.remove();
}

function sanitizeFileName(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "中英对照翻译").slice(0, 120);
}

function getTranslationStats(doc: Document): { done: number; unfinished: number } {
  const blocks = Array.from(doc.querySelectorAll(`.${TRANSLATION_CLASS}`)) as HTMLElement[];
  let done = 0;
  let unfinished = 0;
  for (const block of blocks) {
    if (block.dataset.state === "done" && (block.textContent || "").trim()) done += 1;
    else unfinished += 1;
  }
  return { done, unfinished };
}

function installExportPrintStyle(doc: Document): HTMLStyleElement {
  doc.getElementById(EXPORT_PRINT_STYLE_ID)?.remove();
  const style = doc.createElement("style");
  style.id = EXPORT_PRINT_STYLE_ID;
  style.textContent = `
    @media print {
      html, body {
        background: #fff !important;
        color: #111 !important;
      }
      body {
        margin: 0 !important;
        padding: 0 !important;
      }
      #sdt-content {
        box-sizing: border-box !important;
        width: auto !important;
        max-width: none !important;
        margin: 0 auto !important;
        padding: 0 !important;
      }
      .${TRANSLATION_CLASS} {
        color: #111 !important;
        background: transparent !important;
        border-left-color: #c7354a !important;
        break-inside: avoid;
        page-break-inside: avoid;
      }
      a {
        color: inherit !important;
        text-decoration: none !important;
      }
    }
  `;
  (doc.head || doc.documentElement).append(style);
  return style;
}

async function waitForGeneratedFile(file: any): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if (file.exists() && file.fileSize > 0) return;
    } catch (_) {
      // The file may not exist until the print job finishes flushing.
    }
    await Zotero.Promise.delay(50);
  }
  throw new Error("PDF 已生成，但没有检测到有效的输出文件。");
}

async function importExportedPDF(
  reader: any,
  tempFile: any,
  sourceAttachment: any,
): Promise<any> {
  const parentItemID = Number(sourceAttachment?.parentItemID || 0);
  if (!parentItemID) {
    throw new Error("当前 PDF 没有父级文献条目，无法作为条目附件保存。请先为该 PDF 创建父级条目。 ");
  }

  const parentItem = Zotero.Items.get(parentItemID);
  const parentTitle = String(parentItem?.getField?.("title") || "中英对照翻译").trim();
  const attachment = await (Zotero.Attachments as any).importFromFile({
    file: tempFile,
    parentItemID,
  });
  attachment.setField("title", `${parentTitle || "文献"} - 中英对照翻译`);
  await attachment.saveTx();
  return attachment;
}

export async function exportBilingualPDF(reader: any): Promise<void> {
  const doc = getSDTDocument(reader);
  if (!doc?.querySelector("#sdt-content")) {
    showMessage(reader, "请先在 Zotero 阅读模式中开启中英对照，再导出 PDF。");
    return;
  }

  const { done, unfinished } = getTranslationStats(doc);
  if (!done) {
    showMessage(reader, "当前没有已成功完成的译文，暂时无法导出中英对照 PDF。");
    return;
  }

  if (
    unfinished > 0 &&
    !confirmMessage(
      reader,
      `当前已有 ${done} 段译文完成，仍有 ${unfinished} 段未成功完成。\n\n是否只导出已经成功的中英对照内容？`,
    )
  ) {
    return;
  }

  if (
    !confirmMessage(
      reader,
      "将把当前中英对照阅读结果导出为 PDF，并作为附件加入这篇文献的 Zotero 条目。\n\n继续导出？",
    )
  ) {
    return;
  }

  const itemID = Number(reader?.itemID || 0);
  const sourceAttachment = itemID ? Zotero.Items.get(itemID) : null;
  if (!sourceAttachment) {
    showMessage(reader, "无法取得当前 PDF 的 Zotero 附件条目。");
    return;
  }

  const browsingContext = getSDTBrowsingContext(reader);
  if (!browsingContext?.print) {
    showMessage(reader, "当前 Zotero 10 阅读视图不支持直接生成 PDF，请更新 Zotero 后重试。");
    return;
  }

  const parentItemID = Number((sourceAttachment as any).parentItemID || 0);
  const parentItem = parentItemID ? Zotero.Items.get(parentItemID) : null;
  const parentTitle = String(parentItem?.getField?.("title") || sourceAttachment.getField?.("title") || "文献");
  const fileName = sanitizeFileName(`${parentTitle} - 中英对照翻译.pdf`);
  const tempFile = Zotero.getTempDirectory();
  tempFile.append(`bilingual-reader-${Date.now()}-${fileName}`);

  try {
    if (tempFile.exists()) tempFile.remove(false);
  } catch (_) {
    // A timestamped file should normally not exist.
  }

  const unfinishedBlocks = Array.from(
    doc.querySelectorAll(`.${TRANSLATION_CLASS}:not([data-state="done"])`),
  ) as HTMLElement[];
  const previousDisplays = unfinishedBlocks.map((block) => block.style.display);
  for (const block of unfinishedBlocks) block.style.display = "none";

  const printStyle = installExportPrintStyle(doc);
  let importedAttachment: any = null;

  try {
    const mainWindow = Zotero.getMainWindow() as any;
    const printUtils = mainWindow?.PrintUtils;
    if (!printUtils?.getPrintSettings) {
      throw new Error("无法取得 Zotero 的 PDF 打印设置。");
    }

    const settings = printUtils.getPrintSettings("", false);
    // Firefox nsIPrintSettings: file destination = 1, PDF format = 2.
    settings.outputDestination = 1;
    settings.outputFormat = 2;
    settings.toFileName = tempFile.path;
    settings.printSilent = true;
    settings.printInColor = true;
    settings.printBGColors = true;
    settings.printBGImages = true;
    settings.shrinkToFit = true;
    settings.headerStrLeft = "";
    settings.headerStrCenter = "";
    settings.headerStrRight = "";
    settings.footerStrLeft = "";
    settings.footerStrCenter = "";
    settings.footerStrRight = "";

    await browsingContext.print(settings);
    await waitForGeneratedFile(tempFile);
    importedAttachment = await importExportedPDF(reader, tempFile, sourceAttachment);
  } catch (error: any) {
    Zotero.logError(error as Error);
    showMessage(reader, `导出中英对照 PDF 失败：${error?.message || String(error)}`);
    return;
  } finally {
    printStyle.remove();
    unfinishedBlocks.forEach((block, index) => {
      block.style.display = previousDisplays[index] || "";
    });
    try {
      if (tempFile.exists()) tempFile.remove(false);
    } catch (_) {
      // The imported Zotero attachment has already copied the file.
    }
  }

  if (importedAttachment) {
    showMessage(reader, "已生成中英对照 PDF，并保存到当前文献的 Zotero 附件中。");
  }
}

function enhanceToolbar(event: any): void {
  const { reader, doc, append } = event || {};
  if (!reader || reader.type !== "pdf" || !doc || typeof append !== "function") return;

  removeReaderSettingsButton(doc);
  replaceToggleLabelWithIcon(doc);

  if (!doc.querySelector(`.${EXPORT_BUTTON_CLASS}`)) {
    append(
      createToolbarImageButton(
        doc,
        EXPORT_BUTTON_CLASS,
        PRINTER_ICON,
        "将当前中英对照结果导出为 PDF 并添加到文献附件",
        (button) => {
          if (button.disabled) return;
          button.disabled = true;
          void exportBilingualPDF(reader).finally(() => {
            button.disabled = false;
          });
        },
      ),
    );
  }

  // Keep this second pass because the built-in Bilingual Reader toolbar handler
  // and this UI enhancer are independent Reader listeners.
  doc.defaultView?.setTimeout(() => {
    removeReaderSettingsButton(doc);
    replaceToggleLabelWithIcon(doc);
  }, 0);
}

function cleanupToolbar(reader: any): void {
  let doc: Document | null = null;
  try {
    doc = reader?._iframeWindow?.document || null;
  } catch (_) {
    doc = null;
  }
  doc?.querySelector(`.${EXPORT_BUTTON_CLASS}`)?.remove();
}

export function registerReaderUI(): void {
  Zotero.Reader.registerEventListener("renderToolbar", enhanceToolbar, PLUGIN_ID);
}

export function unregisterReaderUI(): void {
  Zotero.Reader.unregisterEventListener("renderToolbar", enhanceToolbar);
  const readers = ((Zotero.Reader as any)._readers || []) as any[];
  for (const reader of readers) cleanupToolbar(reader);
}
