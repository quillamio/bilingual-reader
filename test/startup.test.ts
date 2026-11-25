import { assert } from "chai";
import { config } from "../package.json";
import { refreshBilingualReading, toggleBilingualReading } from "../src/bilingualReader";
import {
  getCacheMaxEntries, getEngine, getTranslationPageCount, migrateLegacyPreferences, setCacheMaxEntries,
  setTranslateAllPages,
} from "../src/settings";
import { renderReaderToolbar } from "../src/readerToolbar";
import { buildExportHTML, printHTMLToPDF } from "../src/readerUI";
import { composeSideBySidePDF, readPDFFile, writePDFFile } from "../src/pdfVectorExport";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { buildTranslatedPageHTML } from "../src/pdfNativeHtml";
import { freezePDFExportImages } from "../src/pdfExportAssets";
import {
  clearTranslationCache, enforceTranslationCacheLimit, getTranslationCacheStats,
  loadCachedTranslation, saveCachedTranslation,
} from "../src/translationCache";
import {
  SERVICE_CATALOG, getServiceSetting, updateServiceSettings,
} from "../src/serviceCatalog";
import { translateNativeParagraph } from "../src/nativeTranslation";
import {
  parseBingTranslation,
  parseGoogleTranslation,
} from "../src/builtInTranslationServices";
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
    const previousPDFTranslate = (Zotero as any).PDFTranslate;
    (Zotero as any).PDFTranslate = { api: { translate: () => undefined, getVersion: () => "2.4.8" } };
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

      const available = Array.from(engine?.options || []).map((option) => option.value);
      assert.equal(available.length, SERVICE_CATALOG.length + 2);
      for (const required of ["google", "bing", "deeplfree", "gemini", "claude",
        "qwenmt", "libretranslate", "mtranserver", "pdftranslate", "ollama"]) {
        assert.include(available, required);
      }
      assert.exists(win?.document.getElementById("bilingualreader-service-config-section"));
      assert.equal(engine?.value, "pdftranslate");
      assert.equal(engine?.selectedOptions[0].textContent, "Translate for Zotero（默认）");
      assert.notInclude(Array.from(engine!.options).find((option) => option.value === "google")?.label, "默认");
      assert.equal(skipLastPages?.value, "1");
      const input = (id: string) => win!.document.getElementById("bilingualreader-" + id) as HTMLInputElement;
      assert.isFalse(input("translate-all-pages").checked);
      assert.isTrue(input("translate-non-references").checked);
      assert.equal(input("translate-non-references").name, input("translate-all-pages").name);
      assert.equal(input("cache-max-entries").value, "1500");
      assert.notExists(win?.document.getElementById("bilingualreader-builtin-section"));
      assert.notExists(win?.document.getElementById("bilingualreader-pdftranslate-service"));
      assert.notExists(win?.document.getElementById("bilingualreader-pdftranslate-policy"));
      assert.equal(win?.document.getElementById("bilingualreader-pdftranslate-status")?.textContent,
        "使用 Translate for Zotero 2.4.8 的默认服务。");
      const speed = win!.document.getElementById("bilingualreader-speed-section")!;
      const speedRow = speed.querySelector("hbox")!;
      for (let attempt = 0; attempt < 50 && win!.getComputedStyle(speedRow).marginBlockEnd === "0px"; attempt++) {
        await Zotero.Promise.delay(30);
      }
      assert.equal(win!.getComputedStyle(speedRow).marginBlockEnd, "4px");
      assert.equal(win!.getComputedStyle(speed.querySelector("h3")!).marginBlockStart, "0px");
      const layout = win?.document.getElementById("bilingualreader-export-layout") as HTMLSelectElement;
      assert.equal(layout.value, "stacked");
      assert.deepEqual(Array.from(layout.options, (option) => option.value), ["stacked", "side-by-side"]);
      assert.equal(Array.from(engine!.options).find((option) => option.value === "glm47flash")?.label,
        "智谱 GLM-4.7-Flash");
      assert.notExists(win?.document.getElementById("bilingualreader-pdf-layout"));
      assert.notExists(win?.document.getElementById("bilingualreader-pdf2zh-url"));
      assert.isFalse((win?.document.getElementById("bilingualreader-pdf-troubleshooting") as HTMLDetailsElement).open);
      assert.notExists(win?.document.getElementById("bilingualreader-export-original-appendix"));
      assert.notExists(win?.document.getElementById("bilingualreader-use-original-export"));
      assert.notExists(win?.document.getElementById("bilingualreader-save"));
      assert.equal(
        (win?.document.getElementById("bilingualreader-github-link") as HTMLAnchorElement | null)
          ?.href,
        "https://github.com/quillamio/bilingual-reader",
      );
      assert.include(win?.document.getElementById("bilingualreader-github-link")?.parentElement?.textContent,
        "欢迎大家 Star ⭐️");
    } finally {
      (Zotero as any).PDFTranslate = previousPDFTranslate;
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

  it("prints a real PDF with all numbered lines and an embedded red-blue figure", async function () {
    this.timeout(120000);
    const doc = Zotero.getMainWindow().document.implementation.createHTMLDocument("print-regression");
    const root = doc.createElement("div");
    root.id = "sdt-content";
    root.style.cssText = "height:100vh;max-height:100vh;overflow:hidden;contain:strict;";
    for (let i = 0; i < 144; i++) {
      const text = doc.createElement("p");
      text.textContent = "BRLINE" + String(i).padStart(4, "0") + " Original English text must remain visible.";
      if (i % 12 === 11) {
        text.style.cssText = "height:7px;max-height:7px;overflow:hidden;clip-path:inset(0 0 90% 0);";
      }
      root.append(text);
      if (i === 72) {
        const figure = doc.createElement("figure");
        const img = doc.createElement("img");
        img.setAttribute("src", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAYCAIAAAAzn+mLAAAAP0lEQVR4nO3OMRUAIAzEUIqGztWBepQgBglZbswXkJd6PSvhzI10dqQS5BBxiDhEHCIOEYeIQ8Qh4hBxiDhEPgIeAlIwVp1jAAAAAElFTkSuQmCC");
        img.setAttribute("loading", "eager");
        img.setAttribute("width", "240");
        img.setAttribute("height", "120");
        const caption = doc.createElement("figcaption");
        caption.textContent = "BRFIGURE visible red-blue fixture";
        figure.append(img, caption);
        root.append(figure);
      }
    }
    doc.body.append(root);
    const temp = Zotero.getTempDirectory();
    temp.append("br-actual-print-" + Date.now() + ".pdf");
    try {
      await printHTMLToPDF(buildExportHTML(doc, "Printed PDF regression"), temp);
      const parsed = await PDFDocument.load(await readPDFFile(temp), { updateMetadata: false });
      assert.isAtLeast(parsed.getPageCount(), 3);
      // In CI the independent Python renderer verifies text and ink on every page.
      // Locally the real-print smoke test still executes without a workspace path.
      const c = (globalThis as any).Components;
      const env = c.classes["@mozilla.org/process/environment;1"].getService(c.interfaces.nsIEnvironment);
      const fixtureDir = env.get("BR_PDF_REGRESSION_DIR");
      if (fixtureDir) {
        const target = (Zotero.File as any).pathToFile(fixtureDir);
        temp.copyTo(target, "legacy-reflow.pdf");
      }
    } finally {
      if (temp.exists()) temp.remove(false);
    }
  });

  it("exports real side-by-side PDF with continuation sheets", async function () {
    this.timeout(120000);
    const original = await PDFDocument.create();
    const source = original.addPage([595.28, 841.89]);
    const font = await original.embedFont(StandardFonts.Helvetica);
    source.drawText("BRORIGINAL", { x: 60, y: 760, font, size: 18 });
    source.drawRectangle({ x: 50, y: 100, width: 120, height: 100, color: rgb(0, 0, 1) });
    const second = original.addPage([842, 595]);
    second.setCropBox(25, 30, 780, 520);
    second.setRotation(degrees(90));
    second.drawText("BRROTATED", { x: 60, y: 400, font, size: 18 });
    second.drawRectangle({ x: 100, y: 100, width: 100, height: 100, color: rgb(1, 0, 0) });
    const temp = Zotero.getTempDirectory();
    temp.append("br-side-by-side-" + Date.now() + ".pdf");
    const output = Zotero.getTempDirectory();
    output.append("br-side-final-" + Date.now() + ".pdf");
    async function* transcripts() {
      for (let pageIndex = 0; pageIndex < 2; pageIndex++) {
        const paragraphs = Array.from({ length: pageIndex === 0 ? 96 : 1 }, (_, i) => ({
          text: "BRRIGHT" + pageIndex + String(i).padStart(3, "0") + " 中文译文必须完整显示。",
        }));
        try {
          await printHTMLToPDF(buildTranslatedPageHTML({ pageIndex, paragraphs }), temp);
          yield {pageIndex, bytes: await readPDFFile(temp)};
        } finally { if (temp.exists()) temp.remove(false); }
      }
    }
    try {
      const bytes = await composeSideBySidePDF(await original.save(), transcripts(), 2);
      const paired = await PDFDocument.load(bytes);
      assert.isAbove(paired.getPageCount(), 2);
      assert.isAbove(paired.getPage(0).getWidth(), 1190);
      await writePDFFile(output, bytes);
      const c = (globalThis as any).Components;
      const env = c.classes["@mozilla.org/process/environment;1"].getService(c.interfaces.nsIEnvironment);
      const dir = env.get("BR_PDF_REGRESSION_DIR");
      if (dir) output.copyTo((Zotero.File as any).pathToFile(dir), "side-by-side.pdf");
    } finally {
      for (const file of [temp, output]) if (file.exists()) file.remove(false);
    }
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

  it("should parse PDF.js normal-view text without SDT reading-mode data", async function () {
    const stubPage = {
      view: [0, 0, 595, 842],
      getTextContent: async () => ({ items: [
        { str: "Figure 1. Original chart", transform: [10,0,0,10,30,700],
          width: 180, height: 10 },
        { str: "This is the original PDF.", transform: [10,0,0,10,30,650],
          width: 260, height: 10 },
      ] }),
      cleanup: () => undefined,
    };
    const fakePDF = { numPages: 1, getPage: async () => stubPage };
    const reader = { _iframeWindow: {
      PDFViewerApplication: { pdfDocument: fakePDF },
    } };
    const handle = getNormalPDFProxy(reader);
    assert.equal(handle?.pdf, fakePDF);
    const result = await parseNormalPDFWithPDFJS(handle!);
    assert.equal(result.source, "pdfjs");
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0].width, 595);
    assert.equal(result.pages[0].height, 842);
    assert.equal(result.pages[0].blocks[0].type, "caption");
    assert.include(result.pages[0].blocks[1].text, "original PDF");
  });

  it("should prevent Docling external network access", function () {
    assert.equal(validateDoclingEndpoint("http://127.0.0.1:8786"),
      "http://127.0.0.1:8786");
    for (const invalid of [
      "https://127.0.0.1:8786",
      "http://evil.example.com:8786",
      "http://localhost:8786/parse",
    ]) {
      assert.throws(() => validateDoclingEndpoint(invalid), /Docling/u);
    }
  });

  it("renders only the three original toolbar controls by default", function () {
    const doc = Zotero.getMainWindow().document.implementation.createHTMLDocument("toolbar-test");
    const reader = { type: "pdf", itemID: 2147483644 };
    const append = (...elements: HTMLElement[]) => doc.body.append(...elements);

    renderReaderToolbar({ reader, doc, append });
    renderReaderToolbar({ reader, doc, append });

    assert.equal(doc.querySelectorAll(".bilingual-reader-toolbar-button").length, 1);
    assert.equal(doc.querySelectorAll(".bilingual-reader-refresh-button").length, 1);
    assert.equal(doc.querySelectorAll(".bilingual-reader-export-button").length, 1);
    assert.notExists(doc.querySelector(".bilingual-reader-native-pdf-button"));
    assert.notExists(doc.querySelector(".bilingual-reader-native-reading-button"));
    assert.notExists(doc.querySelector(".bilingual-reader-side-by-side-button"));
    assert.equal(doc.querySelector(".bilingual-reader-toolbar-button")?.textContent, "🀄");
    assert.equal(doc.querySelector(".bilingual-reader-export-button")?.textContent, "🖨️");
    assert.notExists(doc.querySelector(".bilingual-reader-settings-button"));
    assert.notExists(doc.querySelector(".bilingual-reader-wordwise-button"));
  });

  it("automatically saves valid edits and restores them when preferences reopen", async function () {
    this.timeout(10000);
    const prefix = "extensions.zotero.bilingualreader.";
    const keys = ["engine", "skipLastPages", "native.doclingURL", "ollama.model",
      "export.layout", "translateAllPages", "cacheMaxEntries"];
    const previous = keys.map((key) => Zotero.Prefs.get(prefix + key, true));

    async function openSettings() {
      const win = Zotero.Utilities.Internal.openPreferences("bilingual-reader-preferences")!;
      assert.exists(win);
      for (let attempt = 0; attempt < 100; attempt++) {
        if (win.document.getElementById("bilingualreader-settings-root")?.dataset.initialized === "true") return win;
        await Zotero.Promise.delay(50);
      }
      throw new Error("Preferences did not load");
    }

    let win = await openSettings();
    try {
      const control = (name: string) => win.document.getElementById("bilingualreader-" + name) as HTMLInputElement;
      const edit = (name: string, value: string, event: string) => {
        const field = control(name);
        field.value = value;
        field.dispatchEvent(new win.Event(event));
      };

      edit("engine", "ollama", "change");
      assert.equal(Zotero.Prefs.get(prefix + "engine", true), "ollama");
      edit("docling-url", "https://example.com", "input");
      assert.equal(control("docling-url").getAttribute("aria-invalid"), "true");
      assert.equal(Zotero.Prefs.get(prefix + "native.doclingURL", true), previous[2]);

      edit("skip-last-pages", "2", "input");
      edit("skip-last-pages", "", "input");
      assert.equal(Zotero.Prefs.get(prefix + "skipLastPages", true), 2);
      edit("skip-last-pages", "3", "input");
      assert.isNull(control("skip-last-pages").getAttribute("aria-invalid"));
      control("translate-all-pages").click();
      assert.isFalse(control("translate-non-references").checked);
      assert.isTrue(control("skip-last-pages").disabled);
      assert.equal(getTranslationPageCount(8), 8);
      assert.equal(Zotero.Prefs.get(prefix + "skipLastPages", true), 3);
      assert.isTrue(Zotero.Prefs.get(prefix + "translateAllPages", true));
      edit("cache-max-entries", "2500", "input");
      assert.equal(getCacheMaxEntries(), 1500);
      edit("cache-max-entries", "2500", "change");
      assert.equal(getCacheMaxEntries(), 2500);
      edit("export-layout", "side-by-side", "change");
      assert.equal(Zotero.Prefs.get(prefix + "export.layout", true), "side-by-side");
      control("ollama-model").focus();
      edit("ollama-model", "autosave-test-model", "input");

      win.close();
      win = await openSettings();
      assert.equal(control("engine").value, "ollama");
      assert.equal(control("skip-last-pages").value, "3");
      assert.equal(control("ollama-model").value, "autosave-test-model");
      assert.equal(control("export-layout").value, "side-by-side");
      assert.isTrue(control("translate-all-pages").checked);
      assert.isFalse(control("translate-non-references").checked);
      assert.isTrue(control("skip-last-pages").disabled);
      assert.equal(control("cache-max-entries").value, "2500");
      control("translate-non-references").click();
      assert.isFalse(control("translate-all-pages").checked);
      assert.isFalse(control("skip-last-pages").disabled);
      assert.equal(getTranslationPageCount(8), 5);
    } finally {
      win.close();
      for (const [index, key] of keys.entries()) {
        if (previous[index] === undefined) Zotero.Prefs.clear(prefix + key, true);
        else Zotero.Prefs.set(prefix + key, previous[index], true);
      }
    }
  });

  it("shows inline results for GLM and MinerU and switches parser fields", async function () {
    this.timeout(10000);
    const prefix = "extensions.zotero.bilingualreader.";
    const keys = ["engine", "services.glm47flash.secret", "services.glm47flash.revision",
      "native.backend", "native.cloud.mineru.key"];
    const previous = keys.map((key) => Zotero.Prefs.get(prefix + key, true));
    const originalRequest = Zotero.HTTP.request;
    const requests: Array<{method: string; url: string; options: any}> = [];
    const win = Zotero.Utilities.Internal.openPreferences("bilingual-reader-preferences")!;
    const control = (id: string) => win.document.getElementById("bilingualreader-" + id) as HTMLElement;
    const edit = (id: string, value: string, event: string) => {
      const field = control(id) as HTMLInputElement;
      field.value = value;
      field.dispatchEvent(new win.Event(event));
    };
    const waitFor = async (status: HTMLElement, state: string) => {
      for (let i = 0; i < 80 && status.dataset.state !== state; i++) await Zotero.Promise.delay(25);
      assert.equal(status.dataset.state, state, status.textContent || "");
    };
    try {
      for (let i = 0; i < 100 && control("settings-root")?.dataset.initialized !== "true"; i++) {
        await Zotero.Promise.delay(50);
      }
      Zotero.HTTP.request = (async (method: string, url: string, options: any) => {
        requests.push({ method, url, options });
        if (url.startsWith("https://open.bigmodel.cn/")) {
          return { status: 200, response: { choices: [{ message: { content: "患者接受了治疗。" } }] } };
        }
        const response = options.headers.Authorization === "Bearer synthetic-mineru"
          ? { code: 0, data: { batch_id: "test-batch", file_urls: ["https://cdn-mineru.openxlab.org.cn/test"] } }
          : { code: "A0211" };
        return { status: 200, response };
      }) as typeof originalRequest;

      const engine = control("engine") as HTMLSelectElement;
      for (const id of ["cnki", "iciba", "mymemory"]) {
        assert.include(Array.from(engine.options).find((option) => option.value === id)?.textContent, "不推荐");
      }
      assert.include(control("dictionary-note").textContent, "Cambridge Dictionary（不推荐）");
      edit("engine", "glm47flash", "change");
      assert.equal(control("service-fields").children.length, 1);
      edit("service-field-secret", "synthetic-glm", "input");
      control("test-service").click();
      const status = control("engine-status");
      await waitFor(status, "success");
      assert.equal(engine.nextElementSibling, status);
      assert.include(status.textContent, "连接成功");
      assert.equal(status.style.backgroundColor, "rgb(220, 252, 231)");
      assert.equal(requests[0].options.headers.Authorization, "Bearer synthetic-glm");
      assert.equal(JSON.parse(requests[0].options.body).model, "glm-4.7-flash");

      (control("pdf-troubleshooting") as HTMLDetailsElement).open = true;
      edit("native-backend", "docling", "change");
      assert.isFalse(control("docling-section").hidden);
      edit("native-backend", "mineru", "change");
      assert.isTrue(control("docling-section").hidden);
      assert.equal(control("docling-section").getBoundingClientRect().height, 0);
      assert.isFalse(control("cloud-mineru-section").hidden);
      assert.include((control("mineru-link") as HTMLAnchorElement).href, "mineru.net/apiManage/");
      edit("cloud-mineru-key", "synthetic-mineru", "input");
      const mineruStatus = control("mineru-status");
      assert.include(mineruStatus.textContent, "已自动保存");
      control("test-mineru").click();
      await waitFor(mineruStatus, "success");
      edit("cloud-mineru-key", "expired-mineru", "input");
      control("test-mineru").click();
      await waitFor(mineruStatus, "error");
      assert.include(mineruStatus.textContent, "已过期");
      assert.deepEqual(requests.slice(1).map(({ method, url }) => [method, url]), [
        ["POST", "https://mineru.net/api/v4/file-urls/batch"],
        ["POST", "https://mineru.net/api/v4/file-urls/batch"],
      ]);
    } catch (error: any) {
      assert.fail(`${String(error)}
${error?.stack || ""}`);
    } finally {
      win.close();
      Zotero.HTTP.request = originalRequest;
      for (const [index, key] of keys.entries()) {
        if (previous[index] === undefined) Zotero.Prefs.clear(prefix + key, true);
        else Zotero.Prefs.set(prefix + key, previous[index], true);
      }
    }
  });

  it("uses Translate for Zotero by default and retains saved engine values on legacy migration", function () {
    const key = "extensions.zotero.bilingualreader.engine";
    const legacy = "extensions.zotero." + key;
    const branch = Zotero.Prefs.rootBranch;
    const previous = [key, legacy].map((name) =>
      branch.prefHasUserValue(name) ? branch.getStringPref(name) : undefined);
    try {
      Zotero.Prefs.clear(key, true);
      assert.equal(getEngine(), "pdftranslate");
      for (const engine of ["google", "ollama", "pdftranslate"]) {
        Zotero.Prefs.set(key, engine, true);
        migrateLegacyPreferences();
        assert.equal(getEngine(), engine);
      }
      Zotero.Prefs.clear(key, true);
      Zotero.Prefs.set(legacy, "ollama", true);
      migrateLegacyPreferences();
      assert.equal(getEngine(), "ollama");
      assert.isFalse(branch.prefHasUserValue(legacy));
      Zotero.Prefs.set(key, "unknown-provider", true);
      assert.equal(getEngine(), "pdftranslate");
    } finally {
      for (const [index, name] of [key, legacy].entries()) {
        if (previous[index] === undefined) Zotero.Prefs.clear(name, true);
        else Zotero.Prefs.set(name, previous[index], true);
      }
    }
  });

  it("should translate through the default Translate for Zotero without overriding its service", async function () {
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
      Zotero.Prefs.clear(prefKey, true);
      assert.equal(getEngine(), "pdftranslate");
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

  it("should parse built-in translation responses without accepting empty results", function () {
    assert.equal(parseGoogleTranslation([[["译文一", "first"], ["译文二", "second"]]]), "译文一译文二");
    assert.equal(
      parseBingTranslation([{ translations: [{ text: "必应译文" }] }]),
      "必应译文",
    );
    assert.throws(() => parseGoogleTranslation({ error: "changed" }), /Google/u);
    assert.throws(() => parseBingTranslation([]), /Bing/u);
  });

  it("should translate directly via Google without Translate for Zotero", async function () {
    this.timeout(10000);
    const prefKey = "extensions.zotero.bilingualreader.engine";
    const previousEngine = Zotero.Prefs.get(prefKey, true);
    const previousPDFTranslate = (Zotero as any).PDFTranslate;
    const previousRequest = Zotero.HTTP.request;
    let requestURL = "";
    let shownError = "";

    const doc = Zotero.getMainWindow().document.implementation.createHTMLDocument("google-test");
    const content = doc.createElement("div");
    content.id = "sdt-content";
    const paragraph = doc.createElement("p");
    paragraph.dataset.refPath = "0";
    paragraph.textContent = `A synthetic Google paragraph ${Date.now()}.`;
    content.append(paragraph);
    doc.body.append(content);

    const reader = {
      itemID: 2147483632,
      _iframeWindow: { alert: (message: string) => { shownError = message; } },
      _internalReader: {
        _lastViewPrimary: true,
        _primarySDTView: {
          _iframeDocument: doc,
          getData: () => ({ structure: null }),
        },
      },
    };

    try {
      Zotero.Prefs.set(prefKey, "google", true);
      (Zotero as any).PDFTranslate = undefined;
      (Zotero.HTTP as any).request = async (method: string, url: string) => {
        assert.equal(method, "GET");
        requestURL = url;
        return {
          status: 200,
          response: [[["内置 Google 翻译成功。", "source text"]]],
        };
      };

      await toggleBilingualReading(reader);
      assert.include(requestURL, "https://translate.google.com/translate_a/single?");
      assert.include(requestURL, "client=gtx");
      assert.include(requestURL, "tl=zh-CN");
      assert.equal(shownError, "");
      assert.equal(
        doc.querySelector(".bilingual-reader-translation")?.textContent,
        "内置 Google 翻译成功。",
      );
    } finally {
      await toggleBilingualReading(reader);
      clearTranslationCache();
      (Zotero.HTTP as any).request = previousRequest;
      (Zotero as any).PDFTranslate = previousPDFTranslate;
      if (previousEngine === undefined) Zotero.Prefs.clear(prefKey, true);
      else Zotero.Prefs.set(prefKey, previousEngine, true);
    }
  });

  it("should isolate per-provider credentials and detect missing API keys", async function () {
    const id = "customgpt3";
    const otherId = "customgpt2";
    const keyPref = "extensions.zotero.bilingualreader.services." + id + ".secret";
    const versionPref = "extensions.zotero.bilingualreader.services." + id + ".revision";
    const oldKey = Zotero.Prefs.get(keyPref, true);
    const oldVersion = Zotero.Prefs.get(versionPref, true);
    try {
      const previousOther = getServiceSetting(otherId, "secret");
      updateServiceSettings(id, { secret: "mock-credential-for-test" });
      assert.equal(getServiceSetting(id, "secret"), "mock-credential-for-test");
      assert.equal(getServiceSetting(otherId, "secret"), previousOther);
      assert.isAbove(Number(Zotero.Prefs.get(versionPref, true)), Number(oldVersion || 0));
    } finally {
      if (oldKey === undefined) Zotero.Prefs.clear(keyPref, true);
      else Zotero.Prefs.set(keyPref, oldKey, true);
      if (oldVersion === undefined) Zotero.Prefs.clear(versionPref, true);
      else Zotero.Prefs.set(versionPref, oldVersion, true);
    }
  });

  it("should call Youdao without another translation plugin", async function () {
    const priorRequest = Zotero.HTTP.request;
    const previousPDFTranslate = (Zotero as any).PDFTranslate;
    let url = "";
    let requestBody = "";
    try {
      (Zotero as any).PDFTranslate = undefined;
      (Zotero.HTTP as any).request = async (method: string, endpoint: string, options: any) => {
        assert.equal(method, "POST");
        url = endpoint;
        requestBody = options.body;
        return { status: 200, response: { errorCode: "0", translation: ["测试译文。"] } };
      };
      const translated = await translateNativeParagraph("The patient was treated.", "youdao");
      assert.equal(translated, "测试译文。");
      assert.equal(url, "https://aidemo.youdao.com/trans");
      assert.include(requestBody, "from=en");
      assert.include(requestBody, "to=zh-CHS");
    } finally {
      (Zotero.HTTP as any).request = priorRequest;
      (Zotero as any).PDFTranslate = previousPDFTranslate;
    }
  });

  it("should parse an independently configured OpenAI-compatible provider", async function () {
    const id = "customgpt1";
    const names = ["secret", "endpoint", "model", "revision"];
    const oldPrefs = names.map((name) =>
      Zotero.Prefs.get("extensions.zotero.bilingualreader.services." + id + "." + name, true),
    );
    const priorRequest = Zotero.HTTP.request;
    let authorization = "";
    let requestedModel = "";
    try {
      updateServiceSettings(id, {
        secret: "mock-secret-not-real",
        endpoint: "https://example.invalid/v1/chat/completions",
        model: "mock-model",
      });
      (Zotero.HTTP as any).request = async (method: string, url: string, options: any) => {
        assert.equal(method, "POST");
        assert.equal(url, "https://example.invalid/v1/chat/completions");
        authorization = options.headers.Authorization;
        requestedModel = JSON.parse(options.body).model;
        return {
          status: 200,
          response: { choices: [{ message: { content: "模拟翻译成功" } }] },
        };
      };
      assert.equal(await translateNativeParagraph("A sample.", id), "模拟翻译成功");
      assert.equal(authorization, "Bearer mock-secret-not-real");
      assert.equal(requestedModel, "mock-model");
    } finally {
      (Zotero.HTTP as any).request = priorRequest;
      names.forEach((name, index) => {
        const pref = "extensions.zotero.bilingualreader.services." + id + "." + name;
        if (oldPrefs[index] === undefined) Zotero.Prefs.clear(pref, true);
        else Zotero.Prefs.set(pref, oldPrefs[index], true);
      });
    }
  });

  it("should render independent per-service input fields on selection", async function () {
    this.timeout(10000);
    const prefix = "extensions.zotero.bilingualreader.";
    const keys = ["engine", "services.gemini.secret", "services.gemini.revision"];
    const previous = keys.map((key) => Zotero.Prefs.get(prefix + key, true));
    const win = Zotero.Utilities.Internal.openPreferences("bilingual-reader-preferences");
    assert.exists(win);
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (win?.document.getElementById("bilingualreader-engine")) break;
        await Zotero.Promise.delay(50);
      }
      const selector = win!.document.getElementById("bilingualreader-engine") as HTMLSelectElement;
      selector.value = "gemini";
      selector.dispatchEvent(new win!.Event("change"));
      const secret = win!.document.getElementById(
        "bilingualreader-service-field-secret",
      ) as HTMLInputElement;
      const endpoint = win!.document.getElementById(
        "bilingualreader-service-field-endpoint",
      ) as HTMLInputElement;
      assert.equal(secret.type, "password");
      secret.value = "synthetic-test-key";
      secret.dispatchEvent(new win!.Event("input"));
      assert.equal(getServiceSetting("gemini", "secret"), "synthetic-test-key");
      assert.include(endpoint.value, "generativelanguage.googleapis.com");
      selector.value = "libretranslate";
      selector.dispatchEvent(new win!.Event("change"));
      assert.equal(
        (win!.document.getElementById(
          "bilingualreader-service-field-endpoint",
        ) as HTMLInputElement).value,
        "http://127.0.0.1:5000",
      );
      selector.value = "gemini";
      selector.dispatchEvent(new win!.Event("change"));
      const restored = win!.document.getElementById("bilingualreader-service-field-secret") as HTMLInputElement;
      assert.equal(restored.value, "synthetic-test-key");
      restored.value = "";
      restored.dispatchEvent(new win!.Event("input"));
      assert.equal(getServiceSetting("gemini", "secret"), "");
      selector.value = "youdao";
      selector.dispatchEvent(new win!.Event("change"));
      assert.equal(
        win!.document.getElementById("bilingualreader-service-fields")?.children.length,
        0,
      );
    } finally {
      win?.close();
      for (const [index, key] of keys.entries()) {
        if (previous[index] === undefined) Zotero.Prefs.clear(prefix + key, true);
        else Zotero.Prefs.set(prefix + key, previous[index], true);
      }
    }
  });

  it("should perform CNKI encryption and token exchange without PDFTranslate", async function () {
    this.timeout(10000);
    const previousRequest = Zotero.HTTP.request;
    const previousPDFTranslate = (Zotero as any).PDFTranslate;
    const requests: string[] = [];
    try {
      (Zotero as any).PDFTranslate = undefined;
      (Zotero.HTTP as any).request = async (method: string, url: string, options: any) => {
        requests.push(url);
        if (url.includes("/getToken")) {
          assert.equal(method, "GET");
          return { status: 200, response: { code: 200, data: "mock-cnki-token" } };
        }
        assert.equal(options.headers.Token, "mock-cnki-token");
        const requestBody = JSON.parse(options.body);
        assert.isString(requestBody.words);
        assert.notInclude(requestBody.words, "Clinical outcome");
        return { status: 200, response: { data: { mResult: "临床结局。" } } };
      };
      assert.equal(await translateNativeParagraph("Clinical outcome", "cnki"), "临床结局。");
      assert.equal(requests.length, 2);
    } finally {
      (Zotero.HTTP as any).request = previousRequest;
      (Zotero as any).PDFTranslate = previousPDFTranslate;
    }
  });

  it("should parse Youdao LLM SSE after signing its request", async function () {
    this.timeout(10000);
    const id = "youdaozhiyunllm";
    const secretPref = "extensions.zotero.bilingualreader.services." + id + ".secret";
    const revisionPref = "extensions.zotero.bilingualreader.services." + id + ".revision";
    const previousSecret = Zotero.Prefs.get(secretPref, true);
    const previousRevision = Zotero.Prefs.get(revisionPref, true);
    const previousRequest = Zotero.HTTP.request;
    try {
      updateServiceSettings(id, { secret: "mock-appid#mock-secret" });
      (Zotero.HTTP as any).request = async (_method: string, url: string) => {
        assert.include(url, "openapi.youdao.com/llm_trans?");
        return {
          status: 200,
          response: "event: message\ndata: {\"transFull\":\"有道模拟译文。\"}\n\n",
        };
      };
      assert.equal(
        await translateNativeParagraph("A medical paper paragraph.", id),
        "有道模拟译文。",
      );
    } finally {
      (Zotero.HTTP as any).request = previousRequest;
      if (previousSecret === undefined) Zotero.Prefs.clear(secretPref, true);
      else Zotero.Prefs.set(secretPref, previousSecret, true);
      if (previousRevision === undefined) Zotero.Prefs.clear(revisionPref, true);
      else Zotero.Prefs.set(revisionPref, previousRevision, true);
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

  it("switches between skipping references and the final page or translating everything", async function () {
    this.timeout(10000);
    const enginePref = "extensions.zotero.bilingualreader.engine";
    const skipPref = "extensions.zotero.bilingualreader.skipLastPages";
    const previousEngine = Zotero.Prefs.get(enginePref, true);
    const previousSkip = Zotero.Prefs.get(skipPref, true);
    const allPref = "extensions.zotero.bilingualreader.translateAllPages";
    const previousAll = Zotero.Prefs.get(allPref, true);
    const previousPDFTranslate = (Zotero as any).PDFTranslate;
    let requestCount = 0;

    const doc = Zotero.getMainWindow().document.implementation.createHTMLDocument("range-test");
    const content = doc.createElement("div");
    content.id = "sdt-content";
    for (const [refPath, text] of [
      ["0", "Paragraph on the first page."],
      ["1", "Reference on the first page."],
      ["2", "Paragraph on the final page."],
      ["3", "Reference on the final page."],
    ]) {
      const paragraph = doc.createElement("p");
      paragraph.dataset.refPath = refPath;
      paragraph.textContent = text;
      if (refPath === "1") paragraph.classList.add("sdt-reference");
      if (refPath === "3") {
        const reference = doc.createElement("section");
        reference.classList.add("sdt-reference");
        reference.append(paragraph);
        content.append(reference);
      } else {
        content.append(paragraph);
      }
    }
    doc.body.append(content);

    const structure = {
      catalog: {
        pages: [{ contentRange: [[0], [2]] }, { contentRange: [[2], [4]] }],
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
      setTranslateAllPages(false);
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

      const translatedRefs = () => Array.from(doc.querySelectorAll(
        '.bilingual-reader-translation[data-state="done"]',
      ), (block) => block.getAttribute("data-source-ref-path"));
      assert.equal(requestCount, 1);
      assert.deepEqual(translatedRefs(), ["0"]);
      assert.equal(getTranslationPageCount(1), 1);

      setTranslateAllPages(true);
      await refreshBilingualReading(reader);
      assert.deepEqual(translatedRefs(), ["0", "1", "2", "3"]);

      setTranslateAllPages(false);
      await refreshBilingualReading(reader);
      assert.deepEqual(translatedRefs(), ["0"]);

      Zotero.Prefs.set(skipPref, 0, true);
      assert.equal(getTranslationPageCount(3), 3, "Keep existing all-pages settings");
      setTranslateAllPages(false);
      assert.equal(getTranslationPageCount(3), 2);
    } finally {
      await toggleBilingualReading(reader);
      clearTranslationCache();
      (Zotero as any).PDFTranslate = previousPDFTranslate;
      if (previousEngine === undefined) Zotero.Prefs.clear(enginePref, true);
      else Zotero.Prefs.set(enginePref, previousEngine, true);
      if (previousSkip === undefined) Zotero.Prefs.clear(skipPref, true);
      else Zotero.Prefs.set(skipPref, previousSkip, true);
      if (previousAll === undefined) Zotero.Prefs.clear(allPref, true);
      else Zotero.Prefs.set(allPref, previousAll, true);
    }
  });

  it("supports more than 1500 cached paragraphs, evicts older entries and can disable caching", async function () {
    const previous = getCacheMaxEntries();
    const save = (i: number) => saveCachedTranslation("cache-test", "Source " + i, "译文 " + i, "mock", () => false);
    const load = (i: number) => loadCachedTranslation("cache-test", "Source " + i, "mock", () => false);
    clearTranslationCache();
    try {
      setCacheMaxEntries(1502);
      for (let i = 0; i <= 1500; i++) save(i);
      assert.equal(getTranslationCacheStats().entries, 1501);
      await Zotero.Promise.delay(5);
      assert.equal(load(0), "译文 0");
      setCacheMaxEntries(2);
      enforceTranslationCacheLimit();
      assert.equal(getTranslationCacheStats().entries, 2);
      assert.isUndefined(load(1));
      assert.equal(load(0), "译文 0");
      assert.equal(load(1500), "译文 1500");
      setCacheMaxEntries(0);
      enforceTranslationCacheLimit();
      save(1501);
      assert.equal(getTranslationCacheStats().entries, 0);
      assert.isUndefined(load(1501));
    } finally {
      clearTranslationCache();
      setCacheMaxEntries(previous);
    }
  });
});
