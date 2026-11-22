import type { LoginStartupStatus } from '../../shared/api/device-types.js';
import { createLatestRequest } from './latest-request.js';

export interface LoginStartupState {
  status: LoginStartupStatus | null;
  pending: boolean;
  error: string | null;
}

export interface LoginStartupPort {
  read(signal: AbortSignal): Promise<LoginStartupStatus>;
  write(enabled: boolean, signal: AbortSignal): Promise<LoginStartupStatus>;
}

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

  start(): Promise<void> {
    this.open = true;
    return this.refresh();
  }

  async refresh({ keepError = false }: { keepError?: boolean } = {}): Promise<void> {
    try {
      const result = await this.requests.run((signal) => this.port.read(signal));
      if (!result.current || !this.open) return;
      this.set({ ...this.state, status: result.value, ...(keepError ? {} : { error: null }) });
    } catch (caught) {
      if (this.open && !(caught instanceof Error && caught.name === 'AbortError')) {
        this.set({ ...this.state, error: caught instanceof Error ? caught.message : '無法讀取登入自啟狀態。' });
      }
    }
  }

  // The user can change the login item in the OS settings while the window is out of focus.
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
      await this.refresh({ keepError: true });
    } finally {
      this.writing = false;
      if (this.open) this.set({ ...this.state, pending: false });
    }
  }

  close(): void {
    this.open = false;
    this.requests.cancel();
  }

  private set(state: LoginStartupState): void {
    this.state = state;
    this.onChange(state);
  }
}

export type LoginStartupNote =
  | { kind: 'pending' | 'loading' | 'unavailable' }
  | { kind: 'error' | 'status'; message: string }
  | null;

export function loginStartupNote({ status, pending, error }: LoginStartupState): LoginStartupNote {
  if (pending) return { kind: 'pending' };
  if (error) return { kind: 'error', message: error };
  if (!status) return { kind: 'loading' };
  if (!status.supported) return { kind: 'unavailable' };
  if (status.state === 'enabled' || status.state === 'disabled') return null;
  return { kind: 'status', message: status.message };
}
