# Issue #33 regression evidence

Baseline: `468c52530669d632f2eabb3b7162a36716dc3b12` (six staged fixes).

Issue: https://github.com/quillamio/bilingual-reader/issues/33 — Zotero 10.0.9, macOS 15.7.1, Translate for Zotero 2.4.8. Coverage progress stopped at 12/12; another PDF failed after consecutive invalid responses. The session recorded 24 HTTP 429 responses, but no per-request trace identifies the exact waiting point.

## Source evidence

- JACC DOI 10.1016/j.jacc.2025.09.015: authorized local source PDF inspected, SHA-256 `ae910786b2ef23fdda10ef9c83ecbc2f38c02491e8e93f4da26b455035f2f080`. 12 pages, all contain extractable text, no repaired/encrypted status. PyMuPDF extracted 1,066 nonempty text blocks. 925 vector drawing objects counted by PyMuPDF. A visible ≥ threshold was extracted as dollar-sign text in this extractor; do not globally replace dollar signs. PDF.js extraction may differ.
- XunZi DOI 10.1038/s41551-026-01769-6: publisher abstract checked. Subscription full text not obtained; tests use independently written examples based on the abstract's terminology. No claim of real PDF export.

## Local evidence

61 earlier core tests and 5 new Issue #33 tests passed under Node 22.16.0 with experimental type stripping. Strict TypeScript check passed for the seven locally available pure/core modules. Full dependency installation and build were blocked by unavailable network/DNS; no Zotero GUI was available. The new PDF composition suite needs the actual pdf-lib dependency and has not been run locally.

The development branch now triggers existing CI. Release publication is explicitly restricted to main. CI status must be checked for the exact commit, not assumed successful.

## Reproduce

```sh
npm ci
npm run build
npm run lint:check
npm run test:unit
BR_ISSUE33_JACC_PDF=/path/to/jacc.pdf BR_ISSUE33_XUNZI_PDF=/path/to/xunzi.pdf node --test test/issue33PDF.node.test.mjs
npm run test:review
```

Optional local PDF tests use synthetic transcripts, not translations, and assert page order/count, landscape sheet geometry, original input hash and complete PDF markers. Full visual verification, actual service calls, PDF.js coverage, source and translated text extractability, figures, cancellation, restarting Zotero, and user-approved partial output still require real Zotero/macOS testing with both source PDFs. Never publish licensed input PDF copies, full article text or user API credentials.
