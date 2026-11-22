type PowerEvent = 'suspend' | 'resume' | 'unlock-screen' | 'user-did-become-active';

export interface PowerEvents {
  on(event: PowerEvent, listener: () => void): unknown;
  removeListener(event: PowerEvent, listener: () => void): unknown;
}

export interface SleepPause {
  asleep: () => void;
  awake: () => void;
}

export function watchSleep(power: PowerEvents, pause: SleepPause): () => void {
  const subscriptions: Array<[PowerEvent, () => void]> = [
    ['suspend', pause.asleep],
    ['resume', pause.awake],
    ['unlock-screen', pause.awake],
    ['user-did-become-active', pause.awake],
  ];
  for (const [event, listener] of subscriptions) power.on(event, listener);
  return () => {
    for (const [event, listener] of subscriptions) power.removeListener(event, listener);
  };
}
