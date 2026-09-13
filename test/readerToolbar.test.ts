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
    // so its process timer cannot mutate the fixtures in parallel.
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

  it("recovers slow readers, new windows, and a replaced toolbar without restarting", async function () {
    this.timeout(6000);
    const slow: any = { type: "pdf" };
    readers.push(slow);
    registerReaderToolbar();
    slow._iframeWindow = makeReader()._iframeWindow;
    const second = makeReader();
    readers.push(second);
    await Zotero.Promise.delay(1200);
    assertButtons(slow._iframeWindow.document);
    assertButtons(second._iframeWindow.document);
    slow._iframeWindow = makeReader()._iframeWindow;
    await Zotero.Promise.delay(1200);
    assertButtons(slow._iframeWindow.document);
  });

  it("isolates a closed reader and leaves non-PDF toolbars alone", function () {
    const epub = makeReader("epub");
    const pdf = makeReader();
    readers.push({ type: "pdf", _isUninitialized: true }, epub, pdf);
    reconcileReaderToolbars();
    assertButtons(epub._iframeWindow.document, 0);
    assertButtons(pdf._iframeWindow.document);
  });

  it("removes controls and stops recovery when the plugin is disabled", async function () {
    const reader = makeReader();
    readers.push(reader);
    registerReaderToolbar();
    unregisterReaderToolbar();
    await Zotero.Promise.delay(1200);
    assertButtons(reader._iframeWindow.document, 0);
    assert.notExists(
      reader._iframeWindow.document.querySelector(".bilingual-reader-toolbar-section"),
    );
  });
});
