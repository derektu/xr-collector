export type InputModality = 'pointer' | 'keyboard';

export type ModalityEvent = { type: 'pointerdown' } | { type: 'keydown'; key: string };

const NAVIGATION_KEYS = new Set(['Tab', 'Enter', ' ']);

export function nextModality(current: InputModality | null, event: ModalityEvent): InputModality | null {
  if (event.type === 'pointerdown') return 'pointer';
  return NAVIGATION_KEYS.has(event.key) ? 'keyboard' : current;
}

export function installInputModality(): void {
  let current: InputModality | null = null;
  const record = (event: ModalityEvent) => {
    current = nextModality(current, event);
    if (current) document.documentElement.dataset.input = current;
  };
  document.addEventListener('pointerdown', () => record({ type: 'pointerdown' }), { capture: true });
  document.addEventListener('keydown', (event) => record({ type: 'keydown', key: event.key }), { capture: true });
}
