import { assert } from "chai";
import { config } from "../package.json";
import { toggleBilingualReading } from "../src/bilingualReader";
import { renderReaderToolbar } from "../src/readerToolbar";
import { buildExportHTML } from "../src/readerUI";
import { freezePDFExportImages } from "../src/pdfExportAssets";
import { clearTranslationCache } from "../src/translationCache";
import { parseNormalPDFWithPDFJS, getNormalPDFProxy } from "../src/pdfNativeRuntime";
import { validateDoclingEndpoint } from "../src/pdfNativeDocling";

describe("startup", function () {
  it("should have plugin instance defined", function () {
    assert.isNotEmpty(Zotero[config.addonInstance]);
  });

  it("should register the preferences pane", function () {
    const pane = Zotero.PreferencePanes.pluginPanes.find(
      (entry) => entry.id === "bilingual-reader-preferences",
    );

    assert.exists(pane);
    assert.equal(pane?.pluginID, config.addonID);
    assert.match(pane?.src || "", /content\/preferences\.xhtml$/u);
  });

  it("should load the preferences controls", async function () {
    this.timeout(10000);
    const win = Zotero.Utilities.Internal.openPreferences("bilingual-reader-preferences");
    assert.exists(win);

    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (win?.document.getElementById("bilingualreader-engine")) break;
        await Zotero.Promise.delay(50);
      }

      assert.exists(win?.document.getElementById("bilingualreader-engine"));
      const engine = win?.document.getElementById(
        "bilingualreader-engine",
      ) as HTMLSelectElement | null;
      const skipLastPages = win?.document.getElementById(
        "bilingualreader-skip-last-pages",
      ) as HTMLInputElement | null;

      assert.deepEqual(
        Array.from(engine?.options || []).map((option) => option.value),
        ["pdftranslate", "ollama"],
      );
      assert.equal(engine?.value, "pdftranslate");
      assert.equal(skipLastPages?.value, "1");
      assert.equal(
        win?.document
          .getElementById("bilingualreader-introduction")
          ?.textContent?.replace(/\s+/gu, " ")
          .trim(),
        "在 Zotero 10 新 PDF 阅读模式中按段落显示英文原文和中文译文。默认使用 Translate for Zotero（推荐使用google，其次必应）；Ollama 作为可选后端保留。",
      );
      assert.notExists(win?.document.getElementById("bilingualreader-pdftranslate-service"));
      assert.include(
        win?.document.getElementById("bilingualreader-pdftranslate-policy")?.textContent || "",
        "固定跟随 Translate for Zotero 当前默认服务",
      );
      assert.exists(win?.document.getElementById("bilingualreader-save"));
      assert.equal(
        (win?.document.getElementById("bilingualreader-github-link") as HTMLAnchorElement | null)
          ?.href,
        "https://github.com/quillamio/bilingual-reader",
      );
    } finally {
      win?.close();
    }
  });

  it("should reflow the printed clone without cutting off negative-offset English/Chinese", function () {
    const doc = Zotero.getMainWindow().document.implementation.createHTMLDocument("export-layout-test");
    const root = doc.createElement("div");
    root.id = "sdt-content";
    root.setAttribute("style", "width: 1300px; transform: translateX(-180px); position: relative;");
    const source = doc.createElement("p");
    source.dataset.refPath = "0";
    source.setAttribute("style", "position: relative; left: -120px; margin-left: -80px; width: 1220px; text-indent: -18px;");
    source.textContent = "The left part of this English paragraph must be visible.";
    const translation = doc.createElement("div");
    translation.className = "bilingual-reader-translation";
    translation.dataset.state = "done";
    translation.style.transform = "translateX(-100px)";
    translation.style.marginLeft = "-70px";
    translation.textContent = "中文段落开头必须完整显示。";
    const figure = doc.createElement("figure");
    const image = doc.createElement("img");
    image.setAttribute("style", "width: 500px; transform: translateX(-20px);");
    image.setAttribute("alt", "Figure artwork");
    figure.append(image);
    root.append(source, translation, figure);
    doc.body.append(root);

    const html = buildExportHTML(doc, "Bilingual export layout");
    assert.include(html, "The left part of this English paragraph must be visible.");
    assert.include(html, "中文段落开头必须完整显示。");
    assert.notInclude(html, "translateX(-180px)");
    assert.notInclude(html, "translateX(-100px)");
    assert.notInclude(html, "left: -120px");
    assert.notInclude(html, "margin-left: -80px");
    assert.include(html, "max-width: 100% !important");
    assert.include(html, "overflow-wrap: anywhere");
    // Artwork is not modified by the text normalization pass.
    assert.include(html, "translateX(-20px)");
    // The exported HTML is normalized, but the live reader remains untouched.
    assert.include(source.style.cssText, "left: -120px");
    assert.include(translation.style.cssText, "translateX(-100px)");
  });

  it("should allow long bilingual paragraphs to flow across PDF pages", function () {
    const doc = Zotero.getMainWindow().document.implementation.createHTMLDocument("page-break-test");
    const root = doc.createElement("div");
    root.id = "sdt-content";
    const paragraph = doc.createElement("p");
    paragraph.textContent = "Long paragraph. ".repeat(2500);
    const translated = doc.createElement("div");
    translated.className = "bilingual-reader-translation";
    translated.dataset.state = "done";
    translated.textContent = "很长的中文译文。".repeat(1500);
    root.append(paragraph, translated);
    doc.body.append(root);
    const html = buildExportHTML(doc, "Pagination regression");
    assert.include(html, "page-break-inside: auto !important");
    assert.include(html, "figure, table, pre {\n    break-inside: auto !important");
    assert.include(html, "tr { break-inside: avoid-page");
    assert.notInclude(html, "figure, table, pre {\n    break-inside: avoid-page");
  });

  it("should preserve existing data-url images in PDF export clones", async function () {
    const doc = Zotero.getMainWindow().document.implementation.createHTMLDocument("image-export-test");
    const root = doc.createElement("div");
    root.id = "sdt-content";
    const figure = doc.createElement("figure");
    const picture = doc.createElement("picture");
    const source = doc.createElement("source");
    source.srcset = "blob:broken-on-print";
    const img = doc.createElement("img");
    const dataURL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
    img.src = dataURL;
    picture.append(source, img);
    figure.append(picture);
    root.append(figure);
    doc.body.append(root);
    const clone = root.cloneNode(true) as HTMLElement;
    const report = await freezePDFExportImages(root, clone);
    assert.equal(report.imageElements, 1);
    assert.equal(report.failed, 0);
    assert.equal(report.preserved, 1);
    const output = buildExportHTML(doc, "Image export", clone);
    assert.include(output, dataURL);
    assert.notInclude(output, 'srcset="blob:broken-on-print"');
    assert.include(root.querySelector("source")?.srcset || "", "blob:broken-on-print");
  });

  it("should replace cloned Canvas with its original PNG pixels", async function () {
    const doc = Zotero.getMainWindow().document.implementation.createHTMLDocument("canvas-export-test");
    const root = doc.createElement("div");
    root.id = "sdt-content";
    const canvas = doc.createElement("canvas");
    canvas.width = 600;
    canvas.height = 300;
    canvas.setAttribute("aria-label", "Scientific figure");
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAAAA";
    Object.defineProperty(canvas, "toDataURL", { value: () => png });
    root.append(canvas);
    doc.body.append(root);
    const clone = root.cloneNode(true) as HTMLElement;
    const report = await freezePDFExportImages(root, clone);
    assert.equal(report.canvasElements, 1);
    assert.equal(report.embedded, 1);
    assert.equal(report.failed, 0);
    const exportedImage = clone.querySelector("img");
    assert.equal(exportedImage?.getAttribute("src"), png);
    assert.equal(exportedImage?.getAttribute("width"), "600");
    assert.equal(exportedImage?.getAttribute("height"), "300");
    assert.equal(exportedImage?.getAttribute("alt"), "Scientific figure");
    assert.exists(root.querySelector("canvas"));
    assert.notExists(root.querySelector("img"));
  });

  it("should render every reader toolbar icon once without post-render DOM rewrites", function () {
    const doc = Zotero.getMainWindow().document.implementation.createHTMLDocument("toolbar-test");
    const reader = { type: "pdf", itemID: 2147483644 };
    const append = (...elements: HTMLElement[]) => doc.body.append(...elements);

    renderReaderToolbar({ reader, doc, append });
    renderReaderToolbar({ reader, doc, append });

    assert.equal(doc.querySelectorAll(".bilingual-reader-toolbar-button").length, 1);
    assert.equal(doc.querySelectorAll(".bilingual-reader-refresh-button").length, 1);
    assert.equal(doc.querySelectorAll(".bilingual-reader-export-button").length, 1);
    assert.equal(doc.querySelectorAll(".bilingual-reader-native-pdf-button").length, 1);
    assert.equal(doc.querySelector(".bilingual-reader-toolbar-button")?.textContent, "🀄");
    assert.equal(doc.querySelector(".bilingual-reader-export-button")?.textContent, "🖨️");
    assert.notExists(doc.querySelector(".bilingual-reader-settings-button"));
    assert.notExists(doc.querySelector(".bilingual-reader-wordwise-button"));
  });

  it("should save the engine and trailing-page settings from Zotero preferences", async function () {
    this.timeout(10000);
    const enginePref = "extensions.zotero.bilingualreader.engine";
    const skipPref = "extensions.zotero.bilingualreader.skipLastPages";
    const previousEngine = Zotero.Prefs.get(enginePref, true);
    const previousSkip = Zotero.Prefs.get(skipPref, true);
    const win = Zotero.Utilities.Internal.openPreferences("bilingual-reader-preferences");
    assert.exists(win);

    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (win?.document.getElementById("bilingualreader-save")) break;
        await Zotero.Promise.delay(50);
      }

      const engine = win?.document.getElementById("bilingualreader-engine") as HTMLSelectElement;
      const skipLastPages = win?.document.getElementById(
        "bilingualreader-skip-last-pages",
      ) as HTMLInputElement;
      const save = win?.document.getElementById("bilingualreader-save") as HTMLButtonElement;

      engine.value = "ollama";
      engine.dispatchEvent(new win!.Event("change"));
      skipLastPages.value = "2";
      save.click();

      assert.equal(Zotero.Prefs.get(enginePref, true), "ollama");
      assert.equal(Zotero.Prefs.get(skipPref, true), 2);
    } finally {
      win?.close();
      if (previousEngine === undefined) Zotero.Prefs.clear(enginePref, true);
      else Zotero.Prefs.set(enginePref, previousEngine, true);
      if (previousSkip === undefined) Zotero.Prefs.clear(skipPref, true);
      else Zotero.Prefs.set(skipPref, previousSkip, true);
    }
  });

  it("should translate through Translate for Zotero without AbortController", async function () {
    this.timeout(10000);
    const prefKey = "extensions.zotero.bilingualreader.engine";
    const obsoleteServicePref = "extensions.zotero.bilingualreader.pdftranslate.service";
    const previousEngine = Zotero.Prefs.get(prefKey, true);
    const previousObsoleteService = Zotero.Prefs.get(obsoleteServicePref, true);
    const previousPDFTranslate = (Zotero as any).PDFTranslate;
    let shownError = "";
    let requestedOptions: Record<string, any> | undefined;

    const doc = Zotero.getMainWindow().document.implementation.createHTMLDocument("reader-test");
    const content = doc.createElement("div");
    content.id = "sdt-content";
    const paragraph = doc.createElement("p");
    paragraph.dataset.refPath = "0";
    paragraph.textContent = `A synthetic paragraph for translation ${Date.now()}.`;
    content.append(paragraph);
    doc.body.append(content);

    const reader = {
      itemID: 2147483647,
      _iframeWindow: {
        alert(message: string) {
          shownError = message;
        },
      },
      _internalReader: {
        _lastViewPrimary: true,
        _primarySDTView: {
          _iframeDocument: doc,
          getData: () => ({ structure: null }),
        },
      },
    };

    try {
      Zotero.Prefs.set(prefKey, "pdftranslate", true);
      // A service saved by an older Bilingual Reader must no longer override
      // Translate for Zotero's current default.
      Zotero.Prefs.set(obsoleteServicePref, "legacy-service", true);
      (Zotero as any).PDFTranslate = {
        api: {
          translate: async (_text: string, options: Record<string, any>) => {
            requestedOptions = options;
            return {
              status: "success",
              result: "集成测试译文。",
              service: "integration-test",
            };
          },
        },
      };

      await toggleBilingualReading(reader);

      const translated = doc.querySelector(".bilingual-reader-translation");
      assert.equal(shownError, "");
      assert.equal(translated?.textContent, "集成测试译文。");
      assert.equal(translated?.getAttribute("data-state"), "done");
      assert.notProperty(requestedOptions, "service");
    } finally {
      await toggleBilingualReading(reader);
      clearTranslationCache();
      (Zotero as any).PDFTranslate = previousPDFTranslate;
      if (previousEngine === undefined) {
        Zotero.Prefs.clear(prefKey, true);
      } else {
        Zotero.Prefs.set(prefKey, previousEngine, true);
      }
      if (previousObsoleteService === undefined) {
        Zotero.Prefs.clear(obsoleteServicePref, true);
      } else {
        Zotero.Prefs.set(obsoleteServicePref, previousObsoleteService, true);
      }
    }
  });

  it("should translate through the selected Ollama engine", async function () {
    this.timeout(10000);
    const enginePref = "extensions.zotero.bilingualreader.engine";
    const previousEngine = Zotero.Prefs.get(enginePref, true);
    const previousRequest = Zotero.HTTP.request;
    let requestedURL = "";

    const doc = Zotero.getMainWindow().document.implementation.createHTMLDocument("ollama-test");
    const content = doc.createElement("div");
    content.id = "sdt-content";
    const paragraph = doc.createElement("p");
    paragraph.dataset.refPath = "0";
    paragraph.textContent = `A synthetic Ollama paragraph ${Date.now()}.`;
    content.append(paragraph);
    doc.body.append(content);

    const reader = {
      itemID: 2147483645,
      _iframeWindow: { alert: () => undefined },
      _internalReader: {
        _lastViewPrimary: true,
        _primarySDTView: {
          _iframeDocument: doc,
          getData: () => ({ structure: null }),
        },
      },
    };

    try {
      Zotero.Prefs.set(enginePref, "ollama", true);
      (Zotero.HTTP as any).request = async (_method: string, url: string) => {
        requestedURL = url;
        return {
          status: 200,
          response: { message: { content: "Ollama 集成测试译文。" } },
        };
      };

      await toggleBilingualReading(reader);

      const translated = doc.querySelector(".bilingual-reader-translation");
      assert.match(requestedURL, /\/api\/chat$/u);
      assert.equal(translated?.textContent, "Ollama 集成测试译文。");
      assert.equal(translated?.getAttribute("data-state"), "done");
    } finally {
      await toggleBilingualReading(reader);
      clearTranslationCache();
      (Zotero.HTTP as any).request = previousRequest;
      if (previousEngine === undefined) Zotero.Prefs.clear(enginePref, true);
      else Zotero.Prefs.set(enginePref, previousEngine, true);
    }
  });

  it("should skip the configured number of trailing PDF pages", async function () {
    this.timeout(10000);
    const enginePref = "extensions.zotero.bilingualreader.engine";
    const skipPref = "extensions.zotero.bilingualreader.skipLastPages";
    const previousEngine = Zotero.Prefs.get(enginePref, true);
    const previousSkip = Zotero.Prefs.get(skipPref, true);
    const previousPDFTranslate = (Zotero as any).PDFTranslate;
    let requestCount = 0;

    const doc = Zotero.getMainWindow().document.implementation.createHTMLDocument("range-test");
    const content = doc.createElement("div");
    content.id = "sdt-content";
    for (const [refPath, text] of [
      ["0", "Paragraph on the first page."],
      ["1", "Paragraph on the final page."],
    ]) {
      const paragraph = doc.createElement("p");
      paragraph.dataset.refPath = refPath;
      paragraph.textContent = text;
      content.append(paragraph);
    }
    doc.body.append(content);

    const structure = {
      catalog: {
        pages: [{ contentRange: [[0], [1]] }, { contentRange: [[1], [2]] }],
      },
    };
    const reader = {
      itemID: 2147483646,
      _iframeWindow: { alert: () => undefined },
      _internalReader: {
        _lastViewPrimary: true,
        _primarySDTView: {
          _iframeDocument: doc,
          getData: () => ({ structure }),
        },
      },
    };

    try {
      Zotero.Prefs.set(enginePref, "pdftranslate", true);
      Zotero.Prefs.set(skipPref, 1, true);
      (Zotero as any).PDFTranslate = {
        api: {
          translate: async () => {
            requestCount += 1;
            return {
              status: "success",
              result: "第一页译文。",
              service: "integration-test",
            };
          },
        },
      };

      await toggleBilingualReading(reader);

      const translations = doc.querySelectorAll(".bilingual-reader-translation");
      assert.equal(requestCount, 1);
      assert.equal(translations.length, 1);
      assert.equal(translations[0].textContent, "第一页译文。");
      assert.equal(content.querySelector('[data-ref-path="1"]')?.nextElementSibling, null);
    } finally {
      await toggleBilingualReading(reader);
      clearTranslationCache();
      (Zotero as any).PDFTranslate = previousPDFTranslate;
      if (previousEngine === undefined) Zotero.Prefs.clear(enginePref, true);
      else Zotero.Prefs.set(enginePref, previousEngine, true);
      if (previousSkip === undefined) Zotero.Prefs.clear(skipPref, true);
      else Zotero.Prefs.set(skipPref, previousSkip, true);
    }
  });
});
