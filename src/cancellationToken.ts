/**
 * Small cancellation primitive that works in Zotero's add-on sandbox.
 *
 * `AbortController` is not exposed in every Zotero 10 JavaScript global. Using
 * an application-owned token also lets us remove every listener explicitly
 * when a delay or request race settles.
 */
export class CancellationToken {
  private listeners = new Set<() => void>();

  public cancelled = false;

  public cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;

    const listeners = Array.from(this.listeners);
    this.listeners.clear();
    for (const listener of listeners) {
      listener();
    }
  }

  public onCancel(listener: () => void): () => void {
    if (this.cancelled) {
      listener();
      return () => undefined;
    }

    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
