import type { LoginStartupStatus } from '../core/types.js';
import { createLatestRequest } from './latest-request.js';

export interface LoginStartupState {
  status: LoginStartupStatus | null;
  pending: boolean;
  error: string | null;
}

/** Reading and writing the operating system's login item; each call answers with what the OS reports. */
export interface LoginStartupPort {
  read(signal: AbortSignal): Promise<LoginStartupStatus>;
  write(enabled: boolean, signal: AbortSignal): Promise<LoginStartupStatus>;
}

/**
 * The login startup switch's state. The switch always shows what the OS reports: a write answers
 * with the OS state read back, a failed write reads the state again instead of keeping the
 * requested value, and the window regaining focus reads it again unless a write is on its way.
 * Only the latest read or write answers, so a slow earlier read never overwrites a newer write.
 */
export class LoginStartupControl {
  private state: LoginStartupState = { status: null, pending: false, error: null };
  private readonly requests = createLatestRequest();
  private writing = false;
  private open = true;

  constructor(private readonly port: LoginStartupPort, private readonly onChange: (state: LoginStartupState) => void,
    private readonly onWritten: (enabled: boolean) => void = () => undefined) {}

  current(): LoginStartupState {
    return this.state;
  }

  /** Starts showing the OS state, again after `close()` when the screen comes back. */
  start(): Promise<void> {
    this.open = true;
    return this.refresh();
  }

  /** Reads the OS state; `clearError` keeps a write's error shown while the state is read again. */
  async refresh(clearError = true): Promise<void> {
    try {
      const result = await this.requests.run((signal) => this.port.read(signal));
      if (!result.current || !this.open) return;
      this.set({ ...this.state, status: result.value, ...(clearError ? { error: null } : {}) });
    } catch (caught) {
      if (this.open && (caught as { name?: string }).name !== 'AbortError') {
        this.set({ ...this.state, error: caught instanceof Error ? caught.message : '無法讀取登入自啟狀態。' });
      }
    }
  }

  /** The window regained focus: the user may have changed the login item in the OS settings. */
  async focus(): Promise<void> {
    if (!this.writing) await this.refresh();
  }

  async write(enabled: boolean): Promise<void> {
    this.writing = true;
    this.set({ ...this.state, pending: true, error: null });
    try {
      const result = await this.requests.run((signal) => this.port.write(enabled, signal));
      if (!result.current || !this.open) return;
      this.set({ ...this.state, status: result.value });
      this.onWritten(enabled);
    } catch (caught) {
      if (!this.open) return;
      this.set({ ...this.state, error: caught instanceof Error ? caught.message : '無法更新登入自啟。' });
      await this.refresh(false);
    } finally {
      this.writing = false;
      if (this.open) this.set({ ...this.state, pending: false });
    }
  }

  /** Drops every answer still on its way, for a screen that went away. */
  close(): void {
    this.open = false;
    this.requests.cancel();
  }

  private set(state: LoginStartupState): void {
    this.state = state;
    this.onChange(state);
  }
}
