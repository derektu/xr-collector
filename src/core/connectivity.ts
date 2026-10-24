import type { CollectionPause } from './collection-pause.js';
import type { ConnectivityState, ConnectivityStatus } from './types.js';

/** Answers whether this device reaches the internet; aborting `signal` gives up the answer. */
export type ConnectivityProbe = (signal: AbortSignal) => Promise<boolean>;

/** How long one probe request may take. */
export const PROBE_TIMEOUT_MS = 5_000;
/** How often an offline device is confirmed again. */
export const OFFLINE_RECHECK_MS = 30_000;
/** How long an online answer stands in for another confirmation after a failed request. */
export const ONLINE_REUSE_MS = 30_000;

/** An address whose answer is known, and how to tell that answer. */
export interface ProbeAddress {
  url: string;
  accepts: (response: Response) => Promise<boolean>;
}

/**
 * Two providers, so neither one being down or blocked reads as a lost network. Plain HTTP with a
 * known answer: a captive portal (a hotel network before sign-in) redirects or answers with its
 * own page, which matches neither. The requests carry no cookie, account or subscription.
 */
const PROBE_ADDRESSES: readonly ProbeAddress[] = [
  { url: 'http://connectivitycheck.gstatic.com/generate_204', accepts: async (response) => response.status === 204 },
  { url: 'http://captive.apple.com/hotspot-detect.html', accepts: async (response) => response.ok && (await response.text()).includes('Success') },
];

/**
 * Online when any address gives its known answer within `PROBE_TIMEOUT_MS`; redirects are not
 * followed. Once one answers, the others are given up. `request` is the HTTP client, so the desktop
 * app can pass one that follows the system's proxy settings.
 */
export function connectivityProbe(addresses: readonly ProbeAddress[], request: typeof fetch = fetch): ConnectivityProbe {
  return async (signal) => {
    const done = new AbortController();
    const answers = addresses.map(async ({ url, accepts }) => {
      const response = await request(url, {
        redirect: 'manual', cache: 'no-store', signal: AbortSignal.any([signal, done.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
      });
      const accepted = await accepts(response);
      await response.body?.cancel().catch(() => undefined);
      if (!accepted) throw new Error(`Unexpected connectivity answer from ${url}`);
      return true;
    });
    try {
      return await Promise.any(answers).catch(() => false);
    } finally {
      done.abort();
    }
  };
}

/** The two providers above, requested with `request`. */
export function internetProbe(request: typeof fetch = fetch): ConnectivityProbe {
  return connectivityProbe(PROBE_ADDRESSES, request);
}

export interface ConnectivityOptions {
  /** The device's collection pause; its `offline` reason is in force while the device is offline. */
  pause: CollectionPause;
  probe?: ConnectivityProbe;
  /** Defaults to `OFFLINE_RECHECK_MS`. */
  offlineRecheckMs?: number;
  /** Defaults to `ONLINE_REUSE_MS`. */
  onlineReuseMs?: number;
  now?: () => Date;
}

/**
 * Whether this device has a network, as collection needs to know it. The device counts as online
 * until a confirmation fails. Nothing is probed while online; a collection request that fails with
 * `network_error` asks for a confirmation, and an online answer stands in for the next ones for a
 * while, so one unreachable source does not probe on every failure. While offline the device is
 * confirmed every `offlineRecheckMs`, except while the system sleeps; waking confirms at once.
 */
export class Connectivity {
  private state: ConnectivityState = 'online';
  private checkedAt: Date | null = null;
  private checking: Promise<ConnectivityState> | null = null;
  private recheck: ReturnType<typeof setTimeout> | null = null;
  private readonly abort = new AbortController();
  private readonly unsubscribePause: () => void;
  private closed = false;

  constructor(private readonly options: ConnectivityOptions) {
    this.unsubscribePause = options.pause.subscribe(({ reason, inForce }) => {
      if (reason === 'sleep' && !inForce && this.state === 'offline') void this.check();
    });
  }

  status(): ConnectivityStatus {
    return { state: this.state, checkedAt: this.checkedAt?.toISOString() ?? null };
  }

  /**
   * After a request failed for lack of a network: confirms the device's network, or answers with
   * the online result of a recent confirmation.
   */
  confirm(): Promise<ConnectivityState> {
    const reuseMs = this.options.onlineReuseMs ?? ONLINE_REUSE_MS;
    if (this.state === 'online' && this.checkedAt && this.now().getTime() - this.checkedAt.getTime() < reuseMs) {
      return Promise.resolve('online');
    }
    return this.check();
  }

  /** Confirms the device's network now; calls while a confirmation runs share it. */
  check(): Promise<ConnectivityState> {
    if (this.closed) return Promise.resolve(this.state);
    this.checking ??= this.probeOnce().finally(() => { this.checking = null; });
    return this.checking;
  }

  close(): void {
    this.closed = true;
    this.abort.abort();
    this.unsubscribePause();
    if (this.recheck) clearTimeout(this.recheck);
    this.recheck = null;
  }

  private async probeOnce(): Promise<ConnectivityState> {
    const online = await (this.options.probe ?? internetProbe())(this.abort.signal).catch(() => false);
    if (this.closed) return this.state;
    this.state = online ? 'online' : 'offline';
    this.checkedAt = this.now();
    // The next round is set before the pause listeners run, so none of them can stop it.
    if (online) {
      if (this.recheck) clearTimeout(this.recheck);
      this.recheck = null;
    } else {
      this.scheduleRecheck();
    }
    this.options.pause.set('offline', !online);
    return this.state;
  }

  private scheduleRecheck(): void {
    if (this.recheck) clearTimeout(this.recheck);
    this.recheck = setTimeout(() => {
      this.recheck = null;
      // A sleeping system is confirmed when it wakes; until then the next round waits.
      if (this.options.pause.has('sleep')) this.scheduleRecheck();
      else void this.check();
    }, this.options.offlineRecheckMs ?? OFFLINE_RECHECK_MS);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}
