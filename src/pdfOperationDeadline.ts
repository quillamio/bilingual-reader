import { PDFExportCancelledError, type PDFExportTask } from "./pdfExportTask.ts";

/** Stage-specific watchdogs for asynchronous PDF export operations. */
export const PDF_DEADLINES = {
  page: 30000, text: 60000, font: 30000, render: 90000,
  image: 30000, browserLoad: 60000, browserReady: 60000,
  fileRead: 60000, fileWrite: 120000, fileMarkers: 10000,
} as const;

export class PDFOperationTimeoutError extends Error {
  constructor(stage: string, timeoutMs: number) {
    super(`${stage}超过 ${Math.round(timeoutMs / 1000)} 秒，已停止等待。`);
    this.name = "PDFOperationTimeoutError";
  }
}

/** A timeout stops waiting, not the underlying operation unless it supports cancellation. */
export async function withPDFOperationDeadline<T>(
  stage: string, timeoutMs: number, run: () => PromiseLike<T> | T,
  onTimeout?: () => void, task?: PDFExportTask,
): Promise<T> {
  task?.throwIfCancelled();
  let unsubscribe: (() => void) | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      const stop = (error: Error) => {
        if (stopped) return;
        stopped = true;
        reject(error);
        try { onTimeout?.(); } catch (_) { /* Preserve the original error. */ }
      };
      timer = setTimeout(() => stop(new PDFOperationTimeoutError(stage, timeoutMs)), timeoutMs);
      unsubscribe = task?.onCancel(() => stop(new PDFExportCancelledError()));
    });
    const result = await Promise.race([deadline, Promise.resolve().then(() => {
      task?.throwIfCancelled();
      return run();
    })]);
    task?.throwIfCancelled();
    return result;
  } finally {
    unsubscribe?.();
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Only for unique temporary paths. A late writer must not leave an orphan file. */
export function writeTemporaryWithDeadline(
  stage: string, timeoutMs: number, write: () => PromiseLike<unknown>, cleanup: () => void,
  task?: PDFExportTask,
): Promise<unknown> {
  let expired = false;
  return withPDFOperationDeadline(stage, timeoutMs, async () => {
    try { return await write(); }
    finally {
      if (expired) {
        try { cleanup(); } catch (_) { /* Best-effort late cleanup. */ }
      }
    }
  }, () => { expired = true; }, task);
}


/** Cancellable inter-request delay without leaving a timer after cancellation. */
export async function waitForPDFExport(milliseconds: number, task?: PDFExportTask): Promise<void> {
  task?.throwIfCancelled();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(resolve, milliseconds);
      unsubscribe = task?.onCancel(() => reject(new PDFExportCancelledError()));
    });
    task?.throwIfCancelled();
  } finally {
    unsubscribe?.();
    if (timer !== undefined) clearTimeout(timer);
  }
}
