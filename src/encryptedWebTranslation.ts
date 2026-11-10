/**
 * Encrypted public-web providers from windingwind/zotero-pdf-translate
 * (AGPL-3.0): CNKI and Iciba. Their private, unofficial endpoints may change,
 * require interactive verification, or block automation.
 */
type Headers = Record<string, string>;
type Fetcher = (
  method: "GET" | "POST", url: string, data?: unknown, headers?: Headers,
  responseType?: "json" | "text",
) => Promise<any>;

const encoder = new TextEncoder();
function b64(bytes: Uint8Array): string {
  const source = Array.from(bytes).map((byte) => String.fromCharCode(byte)).join("");
  return Zotero.getMainWindow().btoa(source);
}
function fromB64(value: string): Uint8Array {
  return Uint8Array.from(Zotero.getMainWindow().atob(value), (char: string) => char.charCodeAt(0));
}
function pad(value: Uint8Array): Uint8Array {
  const needed = 16 - value.length;
  const padArray = new Uint8Array(needed).fill(needed);
  return new Uint8Array([...value, ...padArray]);
}
async function aesEncrypt(text: string, keyValue: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(keyValue), { name: "AES-CBC" }, false, ["encrypt"],
  );
  const input = encoder.encode(text);
  const blocks: Uint8Array[] = [];
  for (let start = 0; start < input.length; start += 16) {
    blocks.push(input.subarray(start, start + 16));
  }
  if (!blocks.length || blocks[blocks.length - 1].length === 16) blocks.push(pad(new Uint8Array()));
  else blocks[blocks.length - 1] = pad(blocks[blocks.length - 1]);
  const zeros = new Uint8Array(16);
  const encrypted: number[] = [];
  for (const block of blocks) {
    const cipher = await crypto.subtle.encrypt({ name: "AES-CBC", iv: block }, key, zeros);
    encrypted.push(...Array.from(new Uint8Array(cipher).slice(0, 16)));
  }
  return new Uint8Array(encrypted);
}
async function aesDecrypt(value: string, keyValue: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(keyValue), { name: "AES-CBC" }, false, ["encrypt", "decrypt"],
  );
  const encrypted = fromB64(value);
  if (encrypted.length % 16) throw new Error("加密译文长度无效。");
  const zeros = new Uint8Array(16);
  const decoded: number[] = [];
  for (let i = 0; i < encrypted.length; i += 16) {
    const block = encrypted.subarray(i, i + 16);
    const paddingBlock = new Uint8Array(16).fill(16);
    const paddingIv = Uint8Array.from(block, (byte, index) => byte ^ paddingBlock[index]);
    const paddingCipher = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-CBC", iv: paddingIv }, key, zeros),
    ).slice(0, 16);
    const blockPayload = new Uint8Array([...block, ...paddingCipher]);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: zeros }, key, blockPayload,
    );
    decoded.push(...Array.from(new Uint8Array(plain)));
  }
  const final = new Uint8Array(decoded);
  const last = final[final.length - 1];
  if (!last || last > 16 || last > final.length) throw new Error("加密译文填充不正确。");
  for (let i = final.length - last; i < final.length; i++) {
    if (final[i] !== last) throw new Error("加密译文填充不正确。");
  }
  return new TextDecoder().decode(final.slice(0, final.length - last));
}
let cnkiToken = "";
let cnkiTokenAt = 0;
async function getCnkiToken(fetch: Fetcher): Promise<string> {
  if (cnkiToken && Date.now() - cnkiTokenAt < 240_000) return cnkiToken;
  const res = await fetch("GET", "https://dict.cnki.net/fyzs-front-api/getToken");
  if (res?.code !== 200 || typeof res?.data !== "string") {
    throw new Error("CNKI 获取访问 Token 失败。");
  }
  cnkiToken = res.data;
  cnkiTokenAt = Date.now();
  return cnkiToken;
}
function split(text: string, size: number): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > size) {
    const point = Math.max(Math.floor(size * 0.6), remaining.lastIndexOf(" ", size));
    chunks.push(remaining.slice(0, point));
    remaining = remaining.slice(point).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
async function cnki(text: string, fetch: Fetcher): Promise<string> {
  const result: string[] = [];
  for (const chunk of split(text, 780)) {
    const encrypted = b64(await aesEncrypt(chunk, "4e87183cfd3a45fe"))
      .replace(/\//g, "_").replace(/\+/g, "-");
    const res = await fetch("POST",
      "https://dict.cnki.net/fyzs-front-api/translate/literaltranslation",
      { words: encrypted, translateType: null },
      { Token: await getCnkiToken(fetch), "Content-Type": "application/json;charset=UTF-8" },
    );
    if (res?.data?.isInputVerificationCode) {
      cnkiToken = "";
      throw new Error("CNKI 要求人工验证，请访问 dict.cnki.net 完成人机校验。");
    }
    const value = res?.data?.mResult;
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("CNKI 未返回正文译文。");
    }
    result.push(value.trim());
  }
  return result.join(" ");
}
function decodeIcibaKey(value: string): string {
  const decoded = decodeURIComponent(value);
  if (!decoded) return "";
  const output = [String.fromCharCode(decoded.charCodeAt(0) - decoded.length)];
  for (let i = 1; i < decoded.length; i++) {
    output.push(String.fromCharCode(decoded.charCodeAt(i) - output[i - 1].charCodeAt(0)));
  }
  return output.join("");
}
async function iciba(text: string, fetch: Fetcher): Promise<string> {
  const auth = "key_web_new_fanyi";
  const client = "6";
  const salt = "6dVjYLFyzfkFkk";
  const key = decodeIcibaKey(
    "%5C%C2%80%C2%9A%C2%A8%C2%B6%C2%B8y%C2%9B%C2%B2%C2%8F%7C%7F%C2%97%C3%88%C2%A9d",
  );
  const result: string[] = [];
  for (const chunk of split(text, 2900)) {
    const hash = Zotero.Utilities.Internal.md5(client + auth + salt + chunk, false).slice(0, 16);
    const sign = b64(await aesEncrypt(hash, key));
    const url = "https://ifanyi.iciba.com/index.php?c=trans&m=fy&client=" +
      client + "&auth_user=" + auth + "&sign=" + encodeURIComponent(sign);
    const body = new URLSearchParams({ from: "en", to: "zh", q: chunk }).toString();
    const res = await fetch("POST", url, body,
      { "Content-Type": "application/x-www-form-urlencoded" });
    if (Number(res?.status) !== 1 || typeof res?.content !== "string") {
      throw new Error("金山词霸网页翻译返回非成功状态。");
    }
    let decrypted: any;
    try { decrypted = JSON.parse(await aesDecrypt(res.content, "aahc3TfyfCEmER33")); }
    catch (_) { throw new Error("金山词霸加密响应解析失败。"); }
    if (!decrypted?.out) throw new Error("金山词霸未返回正文译文。");
    result.push(decrypted.out);
  }
  return result.join(" ");
}

export async function translateEncryptedWebService(
  text: string, id: "cnki" | "iciba", fetch: Fetcher,
): Promise<string> {
  return id === "cnki" ? cnki(text, fetch) : iciba(text, fetch);
}
