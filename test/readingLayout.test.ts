import { assert } from "chai";
import { getNormalPDFProxy, parseNormalPDFWithPDFJS } from "../src/pdfNativeRuntime";
import { renderReaderExportButton } from "../src/readerUI";
import { setPDFLayout, setUseOriginalPDFExport } from "../src/settings";
import { readPDFFile } from "../src/pdfVectorExport";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { cleanupReadingLayout, observeReadingLayout } from "../src/readingLayout";

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
  this.timeout(120000);
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

  nativeTest("imports PDF2zh native LR and keeps original-page export on the same printer", async () => {
    const environment = Components.classes["@mozilla.org/process/environment;1"]
      .getService(Components.interfaces.nsIEnvironment);
    const liveBing = environment.get("BR_LIVE_BING") === "1";
    const endpoint = environment.get("BR_PDF2ZH_LIVE_URL");
    const liveFixture = environment.get("BR_PDF2ZH_LIVE_PDF");
    const endpointPref = "extensions.zotero.bilingualreader.pdf2zh.url";
    const enginePref = "extensions.zotero.bilingualreader.engine";
    const previousEngine = Zotero.Prefs.get(enginePref, true);
    const previousRequest = Zotero.HTTP.request;
    const alerts: string[] = [];
    let testInput = attachment;
    try {
      Zotero.Prefs.set(enginePref, "bing", true);
      if (endpoint && liveFixture) {
        const file = Zotero.File.pathToFile(liveFixture);
        testInput = await Zotero.Attachments.importFromFile({ file, parentItemID: parent.id });
        Zotero.Prefs.set(endpointPref, endpoint, true);
      } else {
        const fixture = await PDFDocument.create();
        fixture.addPage([1224, 792]);
        const bytes = await fixture.save();
        let submitted = "";
        Zotero.HTTP.request = (async (method: string, url: string, options: any) => {
          if (method === "GET" && url.endsWith("/health")) return {
            status: 200, response: { status: "ok", version: "4.1.8", message: "PDF2zh Server is running" },
          };
          if (method === "POST" && url.endsWith("/translate")) {
            const body = JSON.parse(options.body);
            assert.equal(body.engine, "pdf2zh_next");
            assert.equal(body.dualMode, "LR");
            assert.isFalse(body.transFirst);
            assert.isTrue(body.noMono);
            assert.equal(body.skipLastPages, 0);
            assert.equal(options.errorDelayMax, 0);
            assert.notProperty(body, "llm_api");
            submitted = body.fileName.replace(/\.pdf$/u, "");
            return { status: 202, response: { status: "accepted", taskId: "br-test" } };
          }
          if (url.endsWith("/api/tasks")) return { status: 200, response: { tasks: [] } };
          if (url.endsWith("/api/history")) return {
            status: 200, response: { history: [
              { status: "success", taskId: "other", fileList: ["elsewhere.LR_dual.pdf"] },
              { status: "success", taskId: "br-test", fileList: [submitted + ".zh-CN.LR_dual.pdf"] },
            ] },
          };
          assert.isTrue(url.endsWith("/translatedFile/" + submitted + ".zh-CN.LR_dual.pdf"));
          return { status: 200, response: bytes.slice().buffer };
        }) as typeof previousRequest;
      }
      const previousAttachments = parent.getAttachments();
      setPDFLayout("side-by-side");
      await waitForPrinter(printFromToolbar(alerts, testInput.id), endpoint ? 100000 : 20000);
      assert.match(alerts.join("\n"), /PDF2zh 左右对照导出成功/u);
      const attached = parent.getAttachments().filter((id) => !previousAttachments.includes(id));
      assert.lengthOf(attached, 1);
      const exported = Zotero.Items.get(attached[0]);
      const file = Zotero.File.pathToFile((await exported.getFilePathAsync()) as string);
      const pdf = await PDFDocument.load(await readPDFFile(file));
      assert.equal(pdf.getPageCount(), 1);
      assert.equal(pdf.getPage(0).getWidth(), 1224);
      const artifactDir = environment.get("BR_PDF_REGRESSION_DIR");
      if (endpoint && artifactDir) file.copyTo(Zotero.File.pathToFile(artifactDir), "pdf2zh-lr.pdf");
      Zotero.HTTP.request = liveBing ? previousRequest : (async () => ({
        status: 200, response: [{ translations: [{ text: "阅读器测试译文。" }] }],
      })) as typeof previousRequest;

      setPDFLayout("stacked");
      setUseOriginalPDFExport(true);
      await waitForPrinter(printFromToolbar(alerts));
      assert.include(alerts.join("\n"), "原始 PDF 页面及图表已复制");
      const [preservedID] = parent.getAttachments().filter((id) => !previousAttachments.includes(id) && id !== exported.id);
      assert.exists(preservedID);
      const originalFile = Zotero.File.pathToFile((await Zotero.Items.get(preservedID).getFilePathAsync()) as string);
      const preserved = await PDFDocument.load(await readPDFFile(originalFile));
      assert.equal(preserved.getPageCount(), 2);
      assert.equal(preserved.getPage(0).getWidth(), 612);
    } finally {
      Zotero.HTTP.request = previousRequest;
      Zotero.Prefs.set(enginePref, previousEngine, true);
      Zotero.Prefs.clear("extensions.zotero.bilingualreader.pdf.layout", true);
      Zotero.Prefs.clear("extensions.zotero.bilingualreader.export.useOriginal", true);
      Zotero.Prefs.clear(endpointPref, true);
    }
  });

  nativeTest("the same printer renders an offscreen PDF figure in the default stacked export", async () => {
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
    try {
      await waitForPrinter(printFromToolbar(alerts));
      assert.include(alerts.join("\n"), "已生成中英对照 PDF");
      assert.notInclude(alerts.join("\n"), "无法嵌入");
      assert.equal(figure.dataset.sourceCropState, "loaded");
      const [newID] = parent.getAttachments().filter((id) => !initial.includes(id));
      assert.exists(newID);
      const file = Zotero.File.pathToFile((await Zotero.Items.get(newID).getFilePathAsync()) as string);
      const pdf = await PDFDocument.load(await readPDFFile(file));
      assert.isTrue(pdf.context.enumerateIndirectObjects().some(([, object]) =>
        object instanceof PDFRawStream && object.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")));
      const environment = Components.classes["@mozilla.org/process/environment;1"]
        .getService(Components.interfaces.nsIEnvironment);
      const dir = environment.get("BR_PDF_REGRESSION_DIR");
      if (dir) file.copyTo(Zotero.File.pathToFile(dir), "offscreen-reflow.pdf");
    } finally {
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
  nativeTest("the existing reading toggle opens and closes a side panel beside the original PDF", async () => {
    const toolbar = reader._iframeWindow.document;
    const button = toolbar.querySelector(".bilingual-reader-toolbar-button") as HTMLButtonElement;
    const viewer = toolbar.getElementById("split-view") as HTMLElement;
    const previousInset = viewer.style.insetInlineEnd;
    const parserPref = "extensions.zotero.bilingualreader.native.backend";
    const enginePref = "extensions.zotero.bilingualreader.engine";
    const previousEngine = Zotero.Prefs.get(enginePref, true);
    const request = Zotero.HTTP.request;
    const selector = ".bilingual-reader-pdfjs-reading-panel";
    try {
      setPDFLayout("side-by-side");
      Zotero.Prefs.set(enginePref, "bing", true);
      Zotero.Prefs.set(parserPref, "docling", true);
      Zotero.HTTP.request = (async (_method, url) => url.endsWith(":8786/parse") ? {
        status: 200, response: {
          pages: [{ index: 0, width: 612, height: 792, blocks: [{
            id: "fixture-docling", type: "paragraph", order: 0,
            text: "Paragraph returned by Docling.",
            bbox: { left: 50, right: 180, bottom: 690, top: 705 },
          }] }],
        },
      } : {
        status: 200, response: [{ translations: [{ text: "测试译文。" }] }],
      }) as typeof request;
      button.click();
      let panel: HTMLElement | null = null;
      for (let i = 0; i < 80; i++) {
        panel = toolbar.querySelector(selector);
        if (panel?.shadowRoot?.querySelector(".status")?.textContent?.startsWith("已完成")) break;
        await Zotero.Promise.delay(50);
      }
      assert.include(panel?.shadowRoot?.querySelector(".status")?.textContent, "已完成 · 解析：Docling");
      assert.include(panel?.shadowRoot?.querySelector(".en")?.textContent, "Paragraph returned by Docling.");
      assert.notEqual(viewer.style.insetInlineEnd, previousInset);
      assert.isAtMost(viewer.getBoundingClientRect().right, panel!.getBoundingClientRect().left + 1);
      assert.notExists(reader._internalReader._primarySDTView);
      button.click();
      for (let i = 0; i < 20 && toolbar.querySelector(selector); i++) await Zotero.Promise.delay(25);
      assert.notExists(toolbar.querySelector(selector));
      assert.equal(viewer.style.insetInlineEnd, previousInset);
    } finally {
      if (toolbar.querySelector(selector)) button.click();
      Zotero.HTTP.request = request;
      Zotero.Prefs.set(enginePref, previousEngine, true);
      Zotero.Prefs.clear("extensions.zotero.bilingualreader.pdf.layout", true);
      Zotero.Prefs.clear(parserPref, true);
    }
  });

});
