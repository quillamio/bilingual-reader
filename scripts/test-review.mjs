import { Config, Test } from "zotero-plugin-scaffold";
import { createWriteStream } from "node:fs";

if (process.platform === "darwin") {
  process.env.ZOTERO_PLUGIN_ZOTERO_BIN_PATH ||= "/Applications/Zotero.app/Contents/MacOS/zotero";
}
// Only the child instance may be stopped; never run scaffold's global pkill.
process.env.ZOTERO_PLUGIN_KILL_COMMAND = process.platform === "win32" ? "exit /b 0" : "true";

const context = await Config.loadConfig({
  test: { watch: false },
  server: { devtools: false, startArgs: ["-no-remote", "-headless"] },
});
// Scaffold Test uses .scaffold/test/profile and .scaffold/test/data exclusively.
const runner = new Test(context);
await runner.run();
// Keep native exceptions as well as scaffold's structured test summary.
const nativeLog = createWriteStream(".scaffold/review-zotero.log");
runner.zotero.zotero.stdout.pipe(nativeLog);
runner.zotero.zotero.stderr.pipe(nativeLog);
