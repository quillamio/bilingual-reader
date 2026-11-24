import { assert } from "chai";
import { getNormalPDFProxy, parseNormalPDFWithPDFJS } from "../src/pdfNativeRuntime";
import { exportBilingualPDF, renderReaderExportButton } from "../src/readerUI";
import { toggleBilingualReading } from "../src/bilingualReader";
import { getPDFExportLayout, setPDFExportLayout } from "../src/settings";
import { readPDFFile } from "../src/pdfVectorExport";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { cleanupReadingLayout, observeReadingLayout } from "../src/readingLayout";
import { clearTranslationCache } from "../src/translationCache";

function nativeTest(title: string, run: () => Promise<void>): void {
  it(title, async function () {
    try {
      await run();
    } catch (error: any) {
      // Scaffold's JSON reporter drops non-enumerable native Error fields.
      assert.fail(`${String(error)}\n${error?.stack || ""}`);
    }
  });
}

// A tiny generated PDF keeps this regression independent of users' libraries,
// translation services, SDT downloads, and copyrighted sample documents.
function samplePDF(): string {
  const stream = "BT /F1 12 Tf 50 700 Td (Synthetic reader layout test.) Tj ET " +
    "1 0 0 rg 60 410 95 100 re f 0 0 1 rg 155 410 95 100 re f";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  return pdf + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

describe("native Zotero reading-mode highlight layout", function () {
  this.timeout(180000);
  let attachment: Zotero.Item;
  let parent: Zotero.Item;
  let reader: any;
  let view: any;
  let doc: Document;
  let temporaryFile: any;
  let normalPDF: ReturnType<typeof getNormalPDFProxy>;

  before(async function () {
    try {
      temporaryFile = Zotero.getTempDirectory();
      temporaryFile.append(`bilingual-layout-${Date.now()}.pdf`);
      await Zotero.File.putContentsAsync(temporaryFile, samplePDF());
      parent = new Zotero.Item("document");
      parent.setField("title", "Synthetic PDF");
      await parent.saveTx();
      attachment = await Zotero.Attachments.importFromFile({
        file: temporaryFile, parentItemID: parent.id,
      });
      reader = await Zotero.Reader.open(attachment.id);
      await reader._initPromise;
      const internal = reader._internalReader;
      await internal._primaryView.initializedPromise;
      normalPDF = getNormalPDFProxy(reader);

      // Exercise the shipped SDTView and annotation overlay. Only PDF-to-SDT
      // mapping is a fixture; the plugin does not alter that mapping in production.
      const structure = {
        metadata: { processor: { type: "pdf" }, languages: ["en"] },
        catalog: { outline: [], pages: [{ viewRect: [0, 0, 612, 792], contentRange: [[0], [100]] }] },
        content: [
          {
            type: "paragraph",
            content: [{ text: "A source paragraph before the highlighted passage." }],
          },
          { type: "paragraph", content: [{ text: "Highlighted original text remains aligned." }] },
          ...Array.from({ length: 85 }, () => ({
            type: "paragraph", content: [{ text: "Spacer paragraph above an offscreen PDF figure." }],
          })),
          { type: "image", content: [], anchor: { pageRects: [[0, 60, 410, 250, 510]] } },
        ],
      };
      internal._sdt = Components.utils.cloneInto(
        {
          structure,
          mapper: {
            sourceToSDTPosition: () =>
              Components.utils.cloneInto(
                { start: [1, 0, 0], end: [1, 0, 25] },
                reader._iframeWindow,
              ),
            sdtToSourcePosition: () =>
              Components.utils.cloneInto(
                { pageIndex: 0, rects: [[50, 690, 180, 705]] },
                reader._iframeWindow,
              ),
          },
        },
        reader._iframeWindow,
        { cloneFunctions: true },
      );
      await internal._setReadingMode(true, true);
      view = internal._primarySDTView;
      await view.initializedPromise;
      doc = view._iframeDocument;
      view._sourceCropObserver?.disconnect();
      view.setAnnotations(
        Components.utils.cloneInto(
          [
            {
              id: "LAYOUT01",
              type: "highlight",
              color: "#a28ae5",
              text: "Highlighted original text",
              sortIndex: "00000|000000|00000",
              position: { pageIndex: 0, rects: [[50, 690, 180, 705]] },
            },
          ],
          reader._iframeWindow,
        ),
      );
      await Zotero.Promise.delay(250);
      view._handleViewUpdate(true);
    } catch (error: any) {
      assert.fail(`Native reading-mode fixture: ${String(error)}\n${error?.stack || ""}`);
    }
  });

  after(async function () {
    if (doc) cleanupReadingLayout(doc);
    if (reader) reader.close();
    if (parent) await parent.eraseTx();
    if (temporaryFile?.exists()) temporaryFile.remove(false);
  });

  nativeTest("shows the default toolbar and extracts text from an actual Zotero PDF reader", async () => {
    const toolbar = reader._iframeWindow.document;
    for (const name of ["toolbar", "refresh", "export"]) {
      assert.lengthOf(toolbar.querySelectorAll(`.bilingual-reader-${name}-button`), 1);
    }
    assert.notExists(toolbar.querySelector(".bilingual-reader-side-by-side-button"));
    assert.exists(normalPDF, "Zotero's ordinary PDF view must expose the PDF.js document");
    const parsed = await parseNormalPDFWithPDFJS(normalPDF!);
    assert.lengthOf(parsed.pages, 1);
    assert.include(parsed.pages[0].blocks.map((block) => block.text).join(" "), "Synthetic reader layout test.");
  });

  function printFromToolbar(alerts: string[], itemID = attachment.id): HTMLButtonElement {
    const toolbarDoc = doc.implementation.createHTMLDocument("printer");
    renderReaderExportButton({
      reader: {
        type: "pdf", itemID, _internalReader: reader._internalReader,
        _iframeWindow: { confirm: (message: string) => {
          alerts.push(message);
          return true;
        }, alert: (message: string) => alerts.push(message) },
      },
      doc: toolbarDoc,
      append: (...elements: HTMLElement[]) => toolbarDoc.body.append(...elements),
    });
    const button = toolbarDoc.querySelector("button")!;
    button.click();
    return button;
  }

  async function waitForPrinter(button: HTMLButtonElement, timeout = 20000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (button.disabled && Date.now() < deadline) await Zotero.Promise.delay(100);
    assert.isFalse(button.disabled, "Printer action did not finish: " + button.title);
  }

  nativeTest("the default stacked export ignores the removed appendix preference and still embeds figures", async () => {
    const figure = doc.querySelector<HTMLElement>("figure.sdt-source-crop")!;
    assert.equal(figure.dataset.sourceCropState, "ready");
    assert.isNull(figure.querySelector("img")!.getAttribute("src"));

    const translated = doc.createElement("div");
    translated.className = "bilingual-reader-translation";
    translated.dataset.state = "done";
    translated.textContent = "测试译文。";
    doc.querySelector('[data-ref-path="0"]')!.after(translated);
    const initial = parent.getAttachments();
    const alerts: string[] = [];
    const oldPref = "extensions.zotero.bilingualreader.export.useOriginal";
    const previous = Zotero.Prefs.get(oldPref, true);
    try {
      Zotero.Prefs.set(oldPref, true, true);
      await waitForPrinter(printFromToolbar(alerts));
      assert.include(alerts.join("\n"), "已生成中英对照 PDF");
      assert.notInclude(alerts.join("\n"), "无法嵌入");
      assert.equal(figure.dataset.sourceCropState, "loaded");
      const [newID] = parent.getAttachments().filter((id) => !initial.includes(id));
      assert.exists(newID);
      const file = Zotero.File.pathToFile((await Zotero.Items.get(newID).getFilePathAsync()) as string);
      const pdf = await PDFDocument.load(await readPDFFile(file));
      assert.isTrue(pdf.getPages().every(page => page.getWidth() < 600));
      assert.isTrue(pdf.context.enumerateIndirectObjects().some(([, object]) =>
        object instanceof PDFRawStream && object.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")));
      const environment = Components.classes["@mozilla.org/process/environment;1"]
        .getService(Components.interfaces.nsIEnvironment);
      const dir = environment.get("BR_PDF_REGRESSION_DIR");
      if (dir) file.copyTo(Zotero.File.pathToFile(dir), "offscreen-reflow.pdf");
    } finally {
      if (previous === undefined) Zotero.Prefs.clear(oldPref, true);
      else Zotero.Prefs.set(oldPref, previous, true);
      translated.remove();
    }
  });

  nativeTest("prints the original PDF on the left and reuses the current reading translation on the right", async () => {
    const source = doc.querySelector('[data-ref-path="0"]')!;
    const translated = doc.createElement("div");
    translated.className = "bilingual-reader-translation";
    translated.dataset.state = "done";
    translated.dataset.sourceRefPath = "0";
    translated.dataset.sourcePage = "1";
    translated.textContent = "BRSDTRIGHT Zotero 已完成的译文。";
    source.after(translated);
    const originalRequest = Zotero.HTTP.request;
    const previousLayout = getPDFExportLayout();
    const before = parent.getAttachments();
    const alerts: string[] = [];
    let requests = 0;
    try {
      Zotero.HTTP.request = (() => {
        requests++;
        throw new Error("Printing completed translations must not call a translation service.");
      }) as typeof originalRequest;
      setPDFExportLayout("side-by-side");
      await waitForPrinter(printFromToolbar(alerts));
      assert.include(alerts.join("\n"), "左右对照导出成功");
      assert.equal(requests, 0);
      const [id] = parent.getAttachments().filter((itemID) => !before.includes(itemID));
      assert.exists(id);
      const file = Zotero.File.pathToFile((await Zotero.Items.get(id).getFilePathAsync()) as string);
      const pdf = await PDFDocument.load(await readPDFFile(file));
      assert.equal(pdf.getPageCount(), 1);
      assert.isAbove(pdf.getPage(0).getWidth(), 1200);
      const env = Components.classes["@mozilla.org/process/environment;1"]
        .getService(Components.interfaces.nsIEnvironment);
      const dir = env.get("BR_PDF_REGRESSION_DIR");
      if (dir) file.copyTo(Zotero.File.pathToFile(dir), "side-by-side-export.pdf");
    } finally {
      Zotero.HTTP.request = originalRequest;
      setPDFExportLayout(previousLayout);
      translated.remove();
    }
  });

  function alignmentError(): number {
    const path = view._annotationRenderRootEl.querySelector('[data-annotation-id="LAYOUT01"] path');
    assert.exists(path, "Zotero must display the native highlight");
    const range = view.toDisplayedRange({ pageIndex: 0, rects: [[50, 690, 180, 705]] });
    return Math.abs(path.getBoundingClientRect().top - range.getBoundingClientRect().top);
  }

  nativeTest(
    "reproduces stale coordinates and fixes insertion, text growth, resize, and removal",
    async function () {
      assert.isBelow(alignmentError(), 2);
      const block = doc.createElement("div");
      block.className = "bilingual-reader-translation";
      block.style.cssText = "height:70px;line-height:20px";
      block.textContent = "等待翻译…";
      doc.querySelector('[data-ref-path="0"]')!.after(block);
      await Zotero.Promise.delay(100);
      assert.isAbove(alignmentError(), 40, "Without the fix, the cached highlight stays behind");

      observeReadingLayout(view, doc);
      await Zotero.Promise.delay(100);
      assert.isBelow(alignmentError(), 2, "Inserted translation must refresh native coordinates");

      block.style.height = "auto";
      block.textContent = "译文第一行\n译文第二行\n译文第三行\n译文第四行";
      block.style.whiteSpace = "pre-wrap";
      await Zotero.Promise.delay(100);
      assert.isBelow(alignmentError(), 2, "Completed translations must remain aligned");

      block.style.height = "130px";
      await Zotero.Promise.delay(100);
      assert.isBelow(alignmentError(), 2, "Later layout changes must remain aligned");

      block.remove();
      cleanupReadingLayout(doc);
      assert.isBelow(
        alignmentError(),
        2,
        "Turning bilingual display off restores original geometry",
      );
      assert.equal(
        view._annotations[0].position.rects[0][1],
        690,
        "Stored PDF coordinates stay unchanged",
      );
    },
  );

  nativeTest("does not redraw in a loop or after cleanup", async function () {
    let updates = 0;
    const original = view._handleViewUpdate;
    view._handleViewUpdate = (...args: any[]) => {
      updates++;
      return original.apply(view, args);
    };
    try {
      observeReadingLayout(view, doc);
      observeReadingLayout(view, doc);
      await Zotero.Promise.delay(150);
      const settled = updates;
      await Zotero.Promise.delay(150);
      assert.equal(
        updates,
        settled,
        "Rendering the annotation overlay must not retrigger observation",
      );
      cleanupReadingLayout(doc);
      const stopped = updates;
      doc.querySelector('[data-ref-path="0"]')!.textContent += " More text after cleanup.";
      await Zotero.Promise.delay(100);
      assert.equal(updates, stopped);
    } finally {
      cleanupReadingLayout(doc);
      view._handleViewUpdate = original;
    }
  });
  nativeTest("falling back from a failed Zotero reading mode uses MinerU with consent", async () => {
    const env = Components.classes["@mozilla.org/process/environment;1"]
      .getService(Components.interfaces.nsIEnvironment);
    const liveToken = env.get("BR_MINERU_LIVE_TOKEN");
    const enginePref = "extensions.zotero.bilingualreader.engine";
    const tokenPref = "extensions.zotero.bilingualreader.native.cloud.mineru.key";
    const previousEngine = Zotero.Prefs.get(enginePref, true);
    const originalPrefGet = Zotero.Prefs.get;
    const originalRequest = Zotero.HTTP.request;
    const mainWindow = Zotero.getMainWindow();
    const originalFetch = mainWindow.fetch;
    const alerts: string[] = [];
    const consentPrompts: string[] = [];
    const requests: string[] = [];
    const selector = ".bilingual-reader-mineru-reading";
    const toolbar = reader._iframeWindow.document;
    const upload = "https://mineru.oss-cn-shanghai.aliyuncs.com/synthetic";
    const result = "https://cdn-mineru.openxlab.org.cn/synthetic.zip";
    const archive = "UEsDBBQAAAAIAASpeF1ZaYbYRQAAAEwAAAAZAAAAZml4dHVyZV9jb250ZW50X2xpc3QuanNvbouuViqpLEhVslJQKkmtKFHSUVAqSExPjc9MqQCKGehAhYHSIUBaoSCxqDg1RaE0L7OwNDWnUiGpUsE3My+1KFRPqTYWAFBLAQIUAxQAAAAIAASpeF1ZaYbYRQAAAEwAAAAZAAAAAAAAAAAAAACAAQAAAABmaXh0dXJlX2NvbnRlbnRfbGlzdC5qc29uUEsFBgAAAAABAAEARwAAAHwAAAAAAA==";
    let consent = false;
    const failedReader = {
      itemID: attachment.id,
      _internalReader: {
        _primaryView: reader._internalReader._primaryView,
        _setReadingMode: async () => { throw new Error("Synthetic SDT failure"); },
      },
      _iframeWindow: {
        document: toolbar,
        confirm: (message: string) => { consentPrompts.push(message); return consent; },
        alert: (message: string) => { alerts.push(message); },
      },
    };

    try {
      clearTranslationCache();
      Zotero.Prefs.get = ((key: string, global?: boolean) =>
        key === tokenPref ? (liveToken || "synthetic-mineru") : originalPrefGet.call(Zotero.Prefs, key, global)
      ) as typeof originalPrefGet;
      // Keep the user-provided live Token out of Zotero preferences and logs.
      Zotero.Prefs.set(enginePref, "bing", true);
      Zotero.HTTP.request = (async (method: string, url: string, options: any) => {
        requests.push(new URL(url).hostname + " " + method);
        if (url.startsWith("https://edge.microsoft.com/")) {
          return { status: 200, response: [{ translations: [{ text: "MinerU 测试译文。" }] }] };
        }
        if (liveToken) return originalRequest.call(Zotero.HTTP, method, url, options);
        if (url.endsWith("/file-urls/batch")) {
          return { status: 200, response: { code: 0, data: { batch_id: "test", file_urls: [upload] } } };
        }
        if (url.endsWith("/extract-results/batch/test")) {
          return { status: 200, response: { code: 0, data: { extract_result: [{ state: "done", full_zip_url: result }] } } };
        }
        assert.fail("Unexpected MinerU API request");
      }) as typeof originalRequest;
      if (!liveToken) mainWindow.fetch = (async (url: string, options: RequestInit) => {
        if (url === upload) {
          assert.equal(options.method, "PUT");
          assert.isUndefined(options.headers);
          assert.equal(options.credentials, "omit");
          return { ok: true, status: 200 };
        }
        assert.equal(url, result);
        const bytes = Uint8Array.from(mainWindow.atob(archive), (character) => character.charCodeAt(0));
        return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer };
      }) as typeof originalFetch;

      await toggleBilingualReading(failedReader);
      assert.lengthOf(consentPrompts, 1);
      assert.isEmpty(requests);
      assert.notExists(toolbar.querySelector(selector));

      consent = true;
      await toggleBilingualReading(failedReader);
      const panel = toolbar.querySelector(selector) as HTMLElement;
      assert.exists(panel);
      const status = panel.shadowRoot?.querySelector(".status")?.textContent || "";
      assert.include(status, "已完成 · 解析：MinerU", status);
      assert.include(panel.shadowRoot?.querySelector(".en")?.textContent,
        liveToken ? "Synthetic" : "Text parsed uniquely by MinerU.");
      assert.include(panel.shadowRoot?.querySelector(".zh")?.textContent, "MinerU 测试译文。");
      assert.include(requests, "mineru.net POST");

      const before = parent.getAttachments();
      const numberRequests = requests.length;
      const previousLayout = getPDFExportLayout();
      try {
        setPDFExportLayout("side-by-side");
        await exportBilingualPDF(failedReader);
      } finally {
        setPDFExportLayout(previousLayout);
      }
      assert.include(alerts.join("\n"), "左右对照导出成功");
      assert.lengthOf(requests, numberRequests, "Export must reuse the completed MinerU result");
      const [id] = parent.getAttachments().filter((id) => !before.includes(id));
      assert.exists(id);
      const path = await Zotero.Items.get(id).getFilePathAsync() as string;
      const file = Zotero.File.pathToFile(path);
      const pdf = await PDFDocument.load(await readPDFFile(file));
      assert.equal(pdf.getPageCount(), 1);
      assert.isAbove(pdf.getPage(0).getWidth(), 1200);
      const dir = env.get("BR_PDF_REGRESSION_DIR");
      if (dir) file.copyTo(Zotero.File.pathToFile(dir), "mineru-fallback.pdf");

      const beforeStacked = parent.getAttachments();
      try {
        setPDFExportLayout("stacked");
        await exportBilingualPDF(failedReader);
      } finally {
        setPDFExportLayout(previousLayout);
      }
      assert.include(alerts.join("\n"), "上下对照导出成功");
      assert.lengthOf(requests, numberRequests, "Stacked export also reuses the MinerU result");
      const [stackedID] = parent.getAttachments().filter(id => !beforeStacked.includes(id));
      const stackedPath = await Zotero.Items.get(stackedID).getFilePathAsync() as string;
      const stackedFile = Zotero.File.pathToFile(stackedPath);
      const stackedPDF = await PDFDocument.load(await readPDFFile(stackedFile));
      assert.equal(stackedPDF.getPageCount(), 1);
      assert.isBelow(stackedPDF.getPage(0).getWidth(), 600);
      if (dir) stackedFile.copyTo(Zotero.File.pathToFile(dir), "mineru-stacked.pdf");

      await toggleBilingualReading(failedReader);
      assert.notExists(toolbar.querySelector(selector));
    } finally {
      if (toolbar.querySelector(selector)) await toggleBilingualReading(failedReader);
      mainWindow.fetch = originalFetch;
      Zotero.Prefs.get = originalPrefGet;
      Zotero.HTTP.request = originalRequest;
      Zotero.Prefs.set(enginePref, previousEngine, true);
    }
  });

  nativeTest("recovers a missing reading-mode figure from the original PDF when it comes into view", async () => {
    const figure = doc.querySelector<HTMLElement>("figure.sdt-source-crop")!;
    const originalImage = figure.querySelector("img")!;
    originalImage.removeAttribute("src");
    figure.dataset.sourceCropState = "unavailable";

    const originalLogError = Zotero.logError;
    const recoveryErrors: string[] = [];
    Zotero.logError = ((error: Error) => {
      recoveryErrors.push(String(error));
      originalLogError.call(Zotero, error);
    }) as typeof Zotero.logError;
    observeReadingLayout(view, doc, reader);
    try {
      figure.scrollIntoView({ block: "center" });
      for (let attempt = 0; attempt < 100 && figure.dataset.sourceCropState !== "loaded"; attempt++) {
        await Zotero.Promise.delay(50);
      }
      assert.equal(figure.dataset.sourceCropState, "loaded", recoveryErrors.join(" | "));
      const recovered = figure.querySelector("img")!;
      assert.match(recovered.src, /^data:image\/png;base64,/u);
      assert.closeTo(recovered.naturalWidth / recovered.naturalHeight, 1.9, 0.02);
      const canvas = doc.createElement("canvas");
      canvas.width = recovered.naturalWidth;
      canvas.height = recovered.naturalHeight;
      const context = canvas.getContext("2d")!;
      context.drawImage(recovered, 0, 0);
      const pixel = (fraction: number) => Array.from(context.getImageData(
        Math.floor(canvas.width * fraction), Math.floor(canvas.height / 2), 1, 1,
      ).data);
      assert.deepEqual(pixel(0.25), [255, 0, 0, 255]);
      assert.deepEqual(pixel(0.75), [0, 0, 255, 255]);
    } finally {
      Zotero.logError = originalLogError;
      cleanupReadingLayout(doc);
      doc.defaultView?.scrollTo(0, 0);
    }
  });

});
