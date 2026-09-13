import { assert } from "chai";
import { config } from "../package.json";
import { toggleBilingualReading } from "../src/bilingualReader";
import { renderReaderToolbar } from "../src/readerToolbar";
import { clearTranslationCache } from "../src/translationCache";

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

  it("should render every reader toolbar icon once without post-render DOM rewrites", function () {
    const doc = Zotero.getMainWindow().document.implementation.createHTMLDocument("toolbar-test");
    const reader = { type: "pdf", itemID: 2147483644 };
    const append = (...elements: HTMLElement[]) => doc.body.append(...elements);

    renderReaderToolbar({ reader, doc, append });
    renderReaderToolbar({ reader, doc, append });

    assert.equal(doc.querySelectorAll(".bilingual-reader-toolbar-button").length, 1);
    assert.equal(doc.querySelectorAll(".bilingual-reader-refresh-button").length, 1);
    assert.equal(doc.querySelectorAll(".bilingual-reader-export-button").length, 1);
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
