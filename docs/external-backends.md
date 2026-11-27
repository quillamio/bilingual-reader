# External PDF backends and privacy

All new services are opt-in. Local paragraph translation remains the default. Cloud parsers require whole-file upload consent. None is automatically added to the free fallback list.

## Local bridge
Install BabelDOC or PDFMathTranslate-next in a local Python environment. Configure its model using its own CLI config file; keep it private. Verify the CLI works on a sample first. BabelDOC accepts `--config`, PDF2zh-next `--config-file`. Generate a strong token with `python3 -c 'import secrets; print(secrets.token_urlsafe(32))'`. Set `BR_LOCALPDF_TOKEN` and `BR_BABELDOC_CONFIG` and/or `BR_PDF2ZH_CONFIG` (private local config file paths). Run `python3 scripts/local_pdf_server.py --port 8787`. Enter the same token and loopback URL in Zotero, select the engine and export. The server accepts only fixed engine/output choices, uses temporary directories, no shell, a 30-minute subprocess timeout and one job at a time. It expects exactly one upstream mono/dual PDF; if watermark modes emit multiple files, configure the upstream output mode yourself. Left/right pairs upstream mono with original; unequal page counts rejected. Stacked uses upstream dual format, not paragraph-level stacked layout. Cancellation stops waiting; subprocess may continue. Engine may use remote models and download assets, not guaranteed offline. No auto-install/start or automatic cloud fallback.
Upstream: https://github.com/funstory-ai/BabelDOC and https://github.com/PDFMathTranslate/PDFMathTranslate-next.

## Cloud parsing
Doc2X official v2 preupload, signed PUT and status with v2/v3-2026; Mathpix v3 multipart, status and lines.json with App ID/App Key. Both map text to physical page numbers, not invented paragraph coordinates. PDF.js alignment and continuation rules apply. Mathpix requests improve_mathpix=false, not zero-retention guarantee. Both may charge. Keys stored in Zotero preferences. Docs: https://doc2x.noedgeai.com/help/en/api/doc2x-api-v2-pdf-interface.html and https://docs.mathpix.com/reference/post-v3-pdf.

## Text
SiliconFlow, OpenRouter and Google Cloud Basic v2: separate credential profiles, fixed official endpoints. Free model selection is not unlimited. Cloud billing/API must be enabled where required. Docs https://docs.siliconflow.cn/docs/api/chat-completions-post, https://openrouter.ai/docs, https://cloud.google.com/translate/docs/reference/rest/v2/translate.

## Doclingo
https://doclingo.ai/zh/doclingoApi confirms paid API; free website characters cannot be used. Public page does not expose the authenticated endpoint/request schema. Integration blocked pending official developer documentation; no guessed endpoint or private browser API.

## Diagnostics
Last 300 allowlisted in-memory events only. No manuscript text, URLs, file names, task IDs, keys or raw exceptions. View/refresh/clear in preferences; manually copy report. Raw upstream/Zotero logs outside this report are not certified sanitized. No telemetry upload.

2026-11-27: official Doclingo launch article links to https://doclingo.cn/en/doclingoApi/ApiDoc (redirects to doclingo.vip); both that route and the Chinese developer page could not be retrieved in the current verification. Obtain the authenticated documentation from the developer console or support@doclingo.ai before implementing any request. No guessed endpoints.
