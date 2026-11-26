const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

export function keepInView(id: string, root: HTMLElement): () => void {
  const reveal = () => {
    const element = document.getElementById(id);
    if (!element) return false;
    const bounds = element.getBoundingClientRect();
    if (bounds.top < 0 || bounds.bottom > window.innerHeight) element.scrollIntoView({ block: 'center' });
    return true;
  };
  const layout = new ResizeObserver(() => { reveal(); });
  const observeLayout = () => {
    const container = document.getElementById(id)?.closest<HTMLElement>('.settings-sections, .onboarding-card');
    if (!container || !reveal()) return false;
    layout.observe(container);
    return true;
  };
  const mount = new MutationObserver(() => { if (observeLayout()) mount.disconnect(); });
  if (!observeLayout()) mount.observe(root, { childList: true, subtree: true });

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    mount.disconnect();
    layout.disconnect();
    root.removeEventListener('wheel', stop);
    root.removeEventListener('touchstart', stop);
    root.removeEventListener('pointerdown', pointer);
    root.removeEventListener('keydown', keyboard);
  };
  const pointer = (event: PointerEvent) => { if (event.target === root) stop(); };
  const keyboard = (event: KeyboardEvent) => { if (SCROLL_KEYS.has(event.key)) stop(); };
  root.addEventListener('wheel', stop, { passive: true });
  root.addEventListener('touchstart', stop, { passive: true });
  root.addEventListener('pointerdown', pointer);
  root.addEventListener('keydown', keyboard);
  return stop;
}
