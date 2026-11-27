import { CancellationToken } from "./cancellationToken.ts";

export class PDFExportCancelledError extends Error {
  constructor() {
    super("PDF 导出已取消。");
    this.name = "PDFExportCancelledError";
  }
}

/** One task per reader. Import is a commit boundary, not a cancellable wait. */
export class PDFExportTask extends CancellationToken {
  private importing = false;
  private readonly onImport?: () => void;

  constructor(onImport?: () => void) {
    super();
    this.onImport = onImport;
  }

  public get canCancel(): boolean {
    return !this.cancelled && !this.importing;
  }

  public override cancel(): void {
    if (this.canCancel) super.cancel();
  }

  public throwIfCancelled(): void {
    if (this.cancelled) throw new PDFExportCancelledError();
  }

  public beginImport(): void {
    this.throwIfCancelled();
    if (this.importing) throw new Error("PDF 导出已经进入附件导入阶段。");
    this.importing = true;
    try { this.onImport?.(); } catch (_) { /* A closed reader must not interrupt an import. */ }
  }
}
