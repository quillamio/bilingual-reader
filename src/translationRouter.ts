/** Shared, provider-scoped rate limits. Never bypass a provider's Retry-After. */
export interface RouterCancellation {
  cancelled: boolean;
  onCancel(listener: () => void): () => void;
}
export class TranslationCancelledError extends Error {
  constructor() { super("翻译任务已取消。"); this.name = "TranslationCancelledError"; }
}
export class TranslationHTTPError extends Error {
  public status: number;
  public retryAfterMs: number;
  constructor(status: number, retryAfterMs = 0) {
    super(`翻译服务请求失败（HTTP ${status}）。`);
    this.name = "TranslationHTTPError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}
export function parseRetryAfter(value: unknown, now = Date.now()): number {
  if (typeof value !== "string" || !value.trim()) return 0;
  const text = value.trim();
  const ms = /^\d+(?:\.\d+)?$/u.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : 0;
}
/** Sanitize errors before exposing them: URLs may include PDF text or secrets. */
export function translationHTTPError(error: unknown): TranslationHTTPError | undefined {
  if (error instanceof TranslationHTTPError) return error;
  const e = error as any;
  const xhr = e?.xmlhttp || e?.xhr || e?.response;
  const status = Number(e?.status || xhr?.status || String(e?.message || e || "").match(/(?:HTTP\s*|status(?: code)?\s*[:=]?\s*)([45]\d\d)/iu)?.[1] || 0);
  if (status < 400 || status > 599 || !Number.isInteger(status)) return undefined;
  let retry: unknown;
  try { retry = typeof xhr?.getResponseHeader === "function" ? xhr.getResponseHeader("Retry-After") : e?.getResponseHeader?.("Retry-After"); } catch (_) { /* Header may be inaccessible. */ }
  return new TranslationHTTPError(status, parseRetryAfter(retry));
}
export const FREE_FALLBACK_IDS = ["google", "googleapi", "bing", "tencenttransmart", "youdao", "huoshanweb", "mymemory", "cnki", "iciba"] as const;
export const DEFAULT_FALLBACK_ORDER = "bing,google,tencenttransmart,youdao,huoshanweb";
export function normalizeFallbackOrder(value: string): string[] {
  const allowed = new Set<string>(FREE_FALLBACK_IDS);
  return [...new Set(value.split(/[,，\s]+/u).filter(id => allowed.has(id)))];
}
export function providerGroup(id: string): string {
  return id === "google" || id === "googleapi" ? "google" : id;
}
export interface RouteEngine { id: string; group: string; gapMs: number; }
export interface RouteOptions<T> {
  engines: RouteEngine[];
  timeoutMs: number;
  cancellation?: RouterCancellation;
  request: (engine: string) => Promise<T>;
  validate: (value: T) => boolean;
  onSwitch?: (engine: string) => void;
}
type Lane = { busy: boolean; queue: object[]; nextAt: number; blockedUntil: number; failures: number };
class RouteTimeout extends Error {}
class LaneUnavailable extends Error {
  public until: number;
  constructor(until: number) { super("服务限流或熔断，暂不可用。"); this.until = until; }
}
function check(token?: RouterCancellation): void { if (token?.cancelled) throw new TranslationCancelledError(); }
async function bounded<T>(run: Promise<T>, ms: number, token?: RouterCancellation): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    const stop = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RouteTimeout("翻译请求超时。")), Math.max(1, ms));
      unsubscribe = token?.onCancel(() => reject(new TranslationCancelledError()));
    });
    const result = await Promise.race([run, stop]);
    check(token);
    return result;
  } finally { unsubscribe?.(); if (timer !== undefined) clearTimeout(timer); }
}
async function sleep(ms: number, token?: RouterCancellation): Promise<void> {
  check(token);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(resolve, Math.max(0, ms));
      unsubscribe = token?.onCancel(() => reject(new TranslationCancelledError()));
    });
    check(token);
  } finally { unsubscribe?.(); if (timer !== undefined) clearTimeout(timer); }
}
export class TranslationRouter {
  private lanes = new Map<string, Lane>();
  private baseBackoff: number;
  private rateCooldown: number;
  private breakerCooldown: number;
  constructor(baseBackoff = 1000, rateCooldown = 60000, breakerCooldown = 30000) {
    this.baseBackoff = baseBackoff; this.rateCooldown = rateCooldown; this.breakerCooldown = breakerCooldown;
  }
  private lane(group: string): Lane {
    let lane = this.lanes.get(group);
    if (!lane) { lane = { busy: false, queue: [], nextAt: 0, blockedUntil: 0, failures: 0 }; this.lanes.set(group, lane); }
    return lane;
  }
  private async acquire(lane: Lane, gap: number, timeout: number, token?: RouterCancellation): Promise<void> {
    const ticket = {};
    lane.queue.push(ticket);
    const end = Date.now() + timeout;
    try {
      for (;;) {
        check(token);
        const now = Date.now();
        if (lane.blockedUntil > now) throw new LaneUnavailable(lane.blockedUntil);
        if (now >= end) throw new RouteTimeout("翻译队列等待超时。");
        if (!lane.busy && lane.queue[0] === ticket && now >= lane.nextAt) {
          lane.busy = true; lane.nextAt = now + gap; return;
        }
        await sleep(Math.min(50, end - now, lane.nextAt > now ? lane.nextAt - now : 50), token);
      }
    } finally { const i = lane.queue.indexOf(ticket); if (i >= 0) lane.queue.splice(i, 1); }
  }
  async translate<T>(options: RouteOptions<T>): Promise<T> {
    const { cancellation, timeoutMs } = options;
    const seen = new Set<string>();
    const failures: string[] = [];
    let earliest = Infinity;
    for (const engine of options.engines) {
      if (seen.has(engine.group)) continue;
      seen.add(engine.group);
      const lane = this.lane(engine.group);
      for (let attempt = 0; attempt < 2; attempt++) {
        check(cancellation);
        let acquired = false;
        let rawSettled = false;
        let tracked: Promise<T> | undefined;
        try {
          await this.acquire(lane, engine.gapMs, timeoutMs, cancellation);
          acquired = true;
          if (cancellation?.cancelled) { lane.busy = false; throw new TranslationCancelledError(); }
          try { options.onSwitch?.(engine.id); } catch (_) { /* Progress is best effort. */ }
          // Keep the lane occupied until the actual request settles, even if its caller cancels or times out.
          const raw = Promise.resolve().then(() => { check(cancellation); return options.request(engine.id); });
          tracked = raw.then(value => { rawSettled = true; return value; }, error => { rawSettled = true; throw error; });
          // Release only after the outcome is classified; on a timeout keep the lane until settlement.
          const value = await bounded(tracked, timeoutMs, cancellation);
          if (!options.validate(value)) throw new Error("无有效译文");
          lane.failures = 0; lane.blockedUntil = 0; lane.busy = false;
          return value;
        } catch (error) {
          if (acquired && rawSettled) lane.busy = false;
          else if (acquired && tracked) {
            void tracked.then(() => { lane.busy = false; }, lateError => {
              const http = translationHTTPError(lateError);
              if (http?.status === 429) lane.blockedUntil = Math.max(lane.blockedUntil, Date.now() + Math.max(this.rateCooldown, http.retryAfterMs));
              lane.busy = false;
            });
          }
          if (cancellation?.cancelled || error instanceof TranslationCancelledError) {
            const http = translationHTTPError(error);
            if (http?.status === 429) lane.blockedUntil = Math.max(lane.blockedUntil, Date.now() + Math.max(this.rateCooldown, http.retryAfterMs));
            throw new TranslationCancelledError();
          }
          if (error instanceof LaneUnavailable) { earliest = Math.min(earliest, error.until); failures.push(`${engine.id}:冷却中`); break; }
          const http = translationHTTPError(error);
          const status = http?.status;
          lane.failures++;
          const backoff = Math.min(15 * 60 * 1000, this.baseBackoff * 2 ** Math.min(lane.failures - 1, 10));
          if (status === 429) {
            lane.blockedUntil = Math.max(lane.blockedUntil, Date.now() + Math.max(this.rateCooldown, backoff, http?.retryAfterMs || 0));
          } else if (error instanceof RouteTimeout || lane.failures >= 2 || status === 401 || status === 403) {
            lane.blockedUntil = Math.max(lane.blockedUntil, Date.now() + Math.max(this.breakerCooldown, backoff, http?.retryAfterMs || 0));
          } else if (http?.retryAfterMs) {
            lane.blockedUntil = Math.max(lane.blockedUntil, Date.now() + http.retryAfterMs);
          }
          if (lane.blockedUntil > Date.now()) earliest = Math.min(earliest, lane.blockedUntil);
          failures.push(`${engine.id}:${status ? `HTTP ${status}` : error instanceof RouteTimeout ? "超时" : "无有效译文或服务异常"}`);
          // Never immediately retry a rate-limited provider. Only transient, settled 5xx failures get one retry.
          if (attempt === 0 && rawSettled && status && status >= 500 && lane.blockedUntil <= Date.now()) {
            lane.nextAt = Math.max(lane.nextAt, Date.now() + backoff);
            await sleep(backoff, cancellation);
            continue;
          }
          break;
        }
      }
    }
    const retry = Number.isFinite(earliest) ? `；最早冷却结束约 ${Math.max(1, Math.ceil((earliest - Date.now()) / 1000))} 秒后` : "";
    throw new Error("翻译引擎均未成功：" + failures.join("；") + retry + "。");
  }
}
