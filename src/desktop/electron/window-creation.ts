/** Coalesces every request made while the one main BrowserWindow is still loading. */
export class WindowCreationGate {
  private currentValue: Promise<void> | null = null;

  get current(): Promise<void> | null { return this.currentValue; }

  run(create: () => Promise<void>): Promise<void> {
    if (this.currentValue) return this.currentValue;
    this.currentValue = create().finally(() => { this.currentValue = null; });
    return this.currentValue;
  }
}
