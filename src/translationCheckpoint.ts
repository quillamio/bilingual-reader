/** Local, versioned paragraph checkpoints; pending work is reconstructed from the current document. */
export type CheckpointEntry = { source: string; scope: string; attempts: number; state: "done" | "failed"; text?: string; tag?: string };
export interface CheckpointBackend { read(key: string): string | undefined; write(key: string, value: string): void; }
const MAX_CHARS = 2_000_000;
export function checkpointIdentity(libraryID: number, itemKey: string, itemID: number): string {
  return `${libraryID || 0}:${itemKey || itemID}`;
}
export class TranslationCheckpoint {
  private readonly key: string;
  private readonly identity: string;
  private readonly scope: string;
  private readonly backend: CheckpointBackend;
  constructor(backend: CheckpointBackend, identity: string, scope: string) {
    this.backend = backend; this.identity = identity; this.scope = scope;
    this.key = "document." + encodeURIComponent(identity);
  }
  private read(): CheckpointEntry[] {
    const raw = this.backend.read(this.key);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (parsed.version !== 1 || parsed.identity !== this.identity || !Array.isArray(parsed.entries)) return [];
      return parsed.entries.filter((e: any) => e && typeof e.source === "string" && typeof e.scope === "string" &&
        Number.isInteger(e.attempts) && e.attempts >= 0 && (e.state === "failed" ||
          (e.state === "done" && typeof e.text === "string" && typeof e.tag === "string")));
    } catch (_) { return []; }
  }
  get(source: string, valid: (text: string) => boolean): CheckpointEntry | undefined {
    const entry = this.read().find(e => e.source === source && e.scope === this.scope);
    if (entry?.state === "done" && !valid(entry.text || "")) return undefined;
    return entry;
  }
  record(source: string, result?: { text: string; tag: string }): void {
    const entries = this.read();
    const i = entries.findIndex(e => e.source === source && e.scope === this.scope);
    const old = entries[i];
    // Concurrent runs must not replace a completed paragraph with a late failure.
    if (!result && old?.state === "done") return;
    const entry: CheckpointEntry = { source, scope: this.scope, attempts: (old?.attempts || 0) + 1,
      state: result ? "done" : "failed", ...(result || {}) };
    if (i >= 0) entries[i] = entry; else entries.push(entry);
    const payload = JSON.stringify({ version: 1, identity: this.identity, entries });
    if (payload.length > MAX_CHARS) throw new Error("当前附件断点记录超过容量限制。");
    this.backend.write(this.key, payload);
  }
}
export interface ParagraphPassOptions<T, R> {
  items: T[];
  translate: (item: T) => Promise<R>;
  success: (item: T, result: R) => void;
  failure: (item: T) => void;
  cancelled: () => boolean;
  isCancellation: (error: unknown) => boolean;
  maxConsecutiveFailures: number;
  concurrency?: number;
  progress?: (done: number, total: number, failed: number, paused: boolean) => void;
}
/** Failed items are retried once only if other items succeeded and the failure budget was not exhausted. */
export async function runParagraphPass<T, R>(options: ParagraphPassOptions<T, R>): Promise<{ done: number; failed: number; pending: number; paused: boolean }> {
  let done = 0, streak = 0, paused = false;
  const failed = new Set<T>();
  const check = () => { if (options.cancelled()) throw new Error("翻译任务已取消。"); };
  const report = () => options.progress?.(done, options.items.length, failed.size, paused);
  async function pass(items: T[]): Promise<void> {
    let cursor = 0;
    async function worker(): Promise<void> {
      while (!paused && !options.cancelled()) {
        const index = cursor++;
        if (index >= items.length) return;
        const item = items[index];
        let result: R;
        try { result = await options.translate(item); }
        catch (error) {
          if (options.cancelled() || options.isCancellation(error)) throw error;
          failed.add(item);
          options.failure(item);
          if (++streak >= Math.max(1, options.maxConsecutiveFailures)) paused = true;
          report(); continue;
        }
        check();
        options.success(item, result);
        done++; failed.delete(item); streak = 0;
        report();
      }
    }
    const count = Math.min(items.length, Math.max(1, options.concurrency || 1));
    const results = await Promise.allSettled(Array.from({ length: count }, () => worker()));
    const error = results.find(r => r.status === "rejected");
    if (error?.status === "rejected") throw error.reason;
    check();
  }
  check(); report();
  await pass(options.items);
  if (!paused && done > 0 && failed.size) await pass([...failed]);
  report();
  return { done, failed: failed.size, pending: options.items.length - done - failed.size, paused };
}
