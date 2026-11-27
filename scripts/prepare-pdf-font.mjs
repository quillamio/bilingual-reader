// Download the OFL font at build time only; no runtime font requests.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
const root = new URL("../addon/content/fonts/", import.meta.url);
const revision = "523d033d6cb47f4a80c58a35753646f5c3608a78";
const upstream = "https://raw.githubusercontent.com/notofonts/noto-cjk/" + revision + "/";
const assets = [
  ["NotoSansCJKsc-Regular.otf", "Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf", 16437364, "dc15562470b4f842321894787a0d066879ccff8b"],
  ["OFL-NotoCJK.txt", "LICENSE", 4301, "d952d62c065f3f35fb83a173496e90b21525aef3"],
];
function verified(bytes, size, sha) {
  return bytes.length === size && createHash("sha1").update("blob " + size + "\0").update(bytes).digest("hex") === sha;
}
await mkdir(root, { recursive: true });
for (const [name, path, size, sha] of assets) {
  const file = new URL(name, root);
  const current = await readFile(file).catch(() => undefined);
  if (current && verified(current, size, sha)) continue;
  const response = await fetch(upstream + path, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error("Unable to obtain pinned Noto CJK asset: HTTP " + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!verified(bytes, size, sha)) throw new Error("Noto CJK asset checksum mismatch: " + name);
  const temporary = new URL(name + ".tmp-" + process.pid, root);
  try { await writeFile(temporary, bytes); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}
console.log("Verified bundled Noto CJK font and OFL license.");
