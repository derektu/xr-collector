import { describe, expect, it, vi } from 'vitest';
import { handleDesktopNavigation } from '../../src/web/desktop-navigation.js';

function actions() {
  return {
    navigate: vi.fn(),
    openSource: vi.fn(),
    refresh: vi.fn(),
    announce: vi.fn(),
  };
}

describe('desktop navigation', () => {
  it('refreshes a source detail reopened by a notification after an external change', () => {
    const next = actions();

    handleDesktopNavigation({ kind: 'source', type: 'youtube', id: 'subscription-a' }, '/sources/youtube/subscription-a', next);

    expect(next.openSource).toHaveBeenCalledWith('youtube', 'subscription-a');
    expect(next.refresh).toHaveBeenCalledOnce();
  });

  it('does not add a redundant refresh when navigation mounts another source detail', () => {
    const next = actions();

    handleDesktopNavigation({ kind: 'source', type: 'youtube', id: 'subscription-b' }, '/sources/youtube/subscription-a', next);

    expect(next.openSource).toHaveBeenCalledWith('youtube', 'subscription-b');
    expect(next.refresh).not.toHaveBeenCalled();
  });
});
