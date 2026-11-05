import { CollectorError } from '../../core/collector-error.js';
import type { ConnectivityState, ConnectivityStatus } from '../../core/device-types.js';

/** The device's network as collection depends on it. */
export interface ConnectivityAccess {
  status(): ConnectivityStatus;
  /** Confirms the network now. */
  check(): Promise<ConnectivityState>;
  /** Confirms the network after a request failed for lack of it. */
  confirm(): Promise<ConnectivityState>;
}

const OFFLINE_MESSAGE = '目前沒有網路，恢復後再試。';

/** How routes that reach the network treat the device's network; without `connectivity`, it is always online. */
export interface NetworkGuard {
  status(): ConnectivityStatus;
  /** Refuses work that would only fail without a network. */
  requireOnline(): void;
  /** Checking subscriptions is how a person asks for the network to be confirmed again. */
  confirmOnline(): Promise<void>;
  /** A preview that found no network confirms it, and answers `offline` when the device has none. */
  confirmingNetwork<T>(work: () => Promise<T>): Promise<T>;
}

export function networkGuard(connectivity: ConnectivityAccess | undefined): NetworkGuard {
  const status = (): ConnectivityStatus => connectivity?.status() ?? { state: 'online', checkedAt: null };
  return {
    status,
    requireOnline: () => {
      if (status().state === 'offline') throw new CollectorError('offline', OFFLINE_MESSAGE);
    },
    confirmOnline: async () => {
      if (connectivity && status().state === 'offline' && await connectivity.check() === 'offline') {
        throw new CollectorError('offline', OFFLINE_MESSAGE);
      }
    },
    confirmingNetwork: async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } catch (error) {
        if (connectivity && error instanceof CollectorError && error.code === 'network_error' && await connectivity.confirm() === 'offline') {
          throw new CollectorError('offline', OFFLINE_MESSAGE, { cause: error });
        }
        throw error;
      }
    },
  };
}
