import * as React from 'react';
import { useState, useSyncExternalStore } from 'react';

export function Count({ subscribe, read }: { subscribe: (listener: () => void) => () => void; read: () => number }) {
  const [shown] = useState(true);
  const value = useSyncExternalStore(subscribe, read);
  return shown ? <span>{React.Children.count(value)}</span> : null;
}
