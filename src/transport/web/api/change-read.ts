export type ReadOutcome<T> = { value: T } | { error: unknown };

export interface ChangeRead {
  read(): void;
  cancel(): void;
}

export function createChangeRead<T>(request: (signal: AbortSignal) => Promise<T>, answer: (outcome: ReadOutcome<T>) => void): ChangeRead {
  let flight: { controller: AbortController; again: boolean } | null = null;
  const start = (): void => {
    const own = { controller: new AbortController(), again: false };
    flight = own;
    void request(own.controller.signal).then((value): ReadOutcome<T> => ({ value }), (error: unknown): ReadOutcome<T> => ({ error })).then((outcome) => {
      if (flight !== own) return;
      flight = null;
      answer(outcome);
      if (own.again) start();
    });
  };
  return {
    read() {
      if (flight) flight.again = true;
      else start();
    },
    cancel() {
      flight?.controller.abort();
      flight = null;
    },
  };
}
