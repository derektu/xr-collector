import { CollectorError } from '../../../shared/lib/collector-error.js';
import type { ConnectivityState, ConnectivityStatus } from '../../../shared/api/device-types.js';

export interface ConnectivityAccess {
  status(): ConnectivityStatus;
  check(): Promise<ConnectivityState>;
  confirm(): Promise<ConnectivityState>;
}

const OFFLINE_MESSAGE = '目前沒有網路，恢復後再試。';

export interface NetworkGuard {
  status(): ConnectivityStatus;
  requireOnline(): void;
  confirmOnline(): Promise<void>;
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
