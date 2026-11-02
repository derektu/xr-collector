import { isDeepStrictEqual } from 'node:util';
import { WAIT_LIMIT_MS } from './wait.js';

/**
 * The captures a test double holds until the test releases them. A capture announces itself the
 * moment it starts waiting, so a test awaits that moment instead of reading the held keys on a timer.
 */
export class HeldCaptures {
  private readonly waiting = new Map<string, () => void>();
  private readonly watchers = new Set<() => void>();

  /** Called by the double's capture; resolves once the test releases `key`. */
  hold(key: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiting.set(key, resolve);
      this.changed();
    });
  }

  /** Keys waiting now, in the order their captures started waiting. */
  running(): string[] {
    return [...this.waiting.keys()];
  }

  has(key: string): boolean {
    return this.waiting.has(key);
  }

  release(key: string): void {
    const resolve = this.waiting.get(key);
    if (!resolve) throw new Error(`capture ${key} is not waiting`);
    this.waiting.delete(key);
    this.changed();
    resolve();
  }

  /** Resolves once every key in `keys` is waiting. */
  started(...keys: string[]): Promise<void> {
    return this.until(() => keys.every((key) => this.waiting.has(key)), `${keys.join(', ')} waiting`);
  }

  /** Resolves once exactly `keys` are waiting, in this order. */
  reach(keys: string[]): Promise<void> {
    return this.until(() => isDeepStrictEqual(this.running(), keys), `exactly ${keys.join(', ')} waiting`);
  }

  /** Resolves once any capture is waiting. */
  any(): Promise<void> {
    return this.until(() => this.waiting.size > 0, 'a capture waiting');
  }

  /** Resolves once exactly `count` captures are waiting. */
  count(count: number): Promise<void> {
    return this.until(() => this.waiting.size === count, `${count} captures waiting`);
  }

  private changed(): void {
    for (const watcher of [...this.watchers]) watcher();
  }

  private until(ready: () => boolean, expected: string): Promise<void> {
    if (ready()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const check = () => {
        if (!ready()) return;
        this.watchers.delete(check);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.watchers.delete(check);
        reject(new Error(`expected ${expected} within ${WAIT_LIMIT_MS} ms; waiting: [${this.running().join(', ')}]`));
      }, WAIT_LIMIT_MS);
      this.watchers.add(check);
    });
  }
}
