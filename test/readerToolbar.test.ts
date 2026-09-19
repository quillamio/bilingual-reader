import { assert } from "chai";
import {
  reconcileReaderToolbars,
  registerReaderToolbar,
  renderReaderToolbar,
  unregisterReaderToolbar,
} from "../src/readerToolbar";

describe("reader toolbar recovery", function () {
  let originalReaders: any[];
  let readers: any[];
  let installedAddon: any;

  before(async function () {
    // This suite imports its own module instance. Disable the installed copy
    // so its recovery tasks cannot mutate the fixtures in parallel.
    const { AddonManager } = ChromeUtils.importESModule(
      "resource://gre/modules/AddonManager.sys.mjs",
    );
    installedAddon = await AddonManager.getAddonByID("bilingual-reader@zotero.local");
    await installedAddon.disable();
  });

  after(async function () {
    await installedAddon.enable();
  });

  beforeEach(function () {
    originalReaders = (Zotero.Reader as any)._readers;
    readers = [];
    (Zotero.Reader as any)._readers = readers;
  });

  afterEach(function () {
    unregisterReaderToolbar();
    (Zotero.Reader as any)._readers = originalReaders;
  });

  function makeReader(type = "pdf") {
    const doc = Zotero.getMainWindow().document.implementation.createHTMLDocument("toolbar");
    doc.body.innerHTML = '<div class="toolbar"><div class="custom-sections"></div></div>';
    return { type, _iframeWindow: { document: doc } };
  }

  function assertButtons(doc: Document, expected = 1) {
    for (const name of ["toolbar", "refresh", "export"]) {
      assert.lengthOf(doc.querySelectorAll(`.bilingual-reader-${name}-button`), expected);
    }
  }

  function renderAsZoteroToolbarEvent(reader: any) {
    const doc = reader._iframeWindow.document as Document;
    const container = doc.querySelector(".toolbar .custom-sections");
    assert.exists(container);
    renderReaderToolbar({
      reader,
      doc,
      append: (...elements: HTMLElement[]) => container!.append(...elements),
    });
  }

  it("fills a toolbar that rendered before installation, without duplicate controls", function () {
    const reader = makeReader();
    readers.push(reader);
    registerReaderToolbar();
    registerReaderToolbar();
    reconcileReaderToolbars();
    assertButtons(reader._iframeWindow.document);
    renderReaderToolbar({
      reader,
      doc: reader._iframeWindow.document,
      append: () => assert.fail("Existing buttons must not be appended twice"),
    });
  });

  it("keeps the fallback toolbar group horizontal and independent of Zotero section styles", function () {
    const reader = makeReader();
    readers.push(reader);
    reconcileReaderToolbars();

    const section = reader._iframeWindow.document.querySelector(
      ".bilingual-reader-toolbar-section",
    ) as HTMLElement | null;
    assert.exists(section);
    assert.isFalse(section!.classList.contains("section"));
    assert.equal(section!.style.display, "inline-flex");
    assert.equal(section!.style.flexDirection, "row");
    assert.equal(section!.style.flexWrap, "nowrap");
    assert.equal(section!.style.flexShrink, "0");
    assertButtons(reader._iframeWindow.document);
  });

  it("recovers a slow restored reader with bounded startup retries", async function () {
    this.timeout(2500);
    const slow: any = { type: "pdf" };
    readers.push(slow);
    registerReaderToolbar();

    slow._iframeWindow = makeReader()._iframeWindow;
    await Zotero.Promise.delay(400);
    assertButtons(slow._iframeWindow.document);
  });

  it("uses the normal renderToolbar event after startup instead of permanent polling", async function () {
    this.timeout(2500);
    const reader = makeReader();
    readers.push(reader);
    registerReaderToolbar();
    assertButtons(reader._iframeWindow.document);

    // Simulate Zotero replacing/remounting the toolbar after the startup
    // recovery window has begun. The official renderToolbar event restores it.
    reader._iframeWindow = makeReader()._iframeWindow;
    renderAsZoteroToolbarEvent(reader);
    assertButtons(reader._iframeWindow.document);
  });

  it("isolates a closed reader and leaves non-PDF toolbars alone", function () {
    const epub = makeReader("epub");
    const pdf = makeReader();
    readers.push({ type: "pdf", _isUninitialized: true }, epub, pdf);
    reconcileReaderToolbars();
    assertButtons(epub._iframeWindow.document, 0);
    assertButtons(pdf._iframeWindow.document);
  });

  it("removes controls and cancels pending startup recovery when disabled", async function () {
    const reader = makeReader();
    readers.push(reader);
    registerReaderToolbar();
    unregisterReaderToolbar();

    reader._iframeWindow = makeReader()._iframeWindow;
    await Zotero.Promise.delay(400);
    assertButtons(reader._iframeWindow.document, 0);
    assert.notExists(
      reader._iframeWindow.document.querySelector(".bilingual-reader-toolbar-section"),
    );
  });
});
