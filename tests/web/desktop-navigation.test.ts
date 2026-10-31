import { describe, expect, it, vi } from 'vitest';
import { handleDesktopNavigation } from '../../src/web/desktop-navigation.js';

function actions() {
  return {
    navigate: vi.fn(),
    openSource: vi.fn(),
    announce: vi.fn(),
  };
}

describe('desktop navigation', () => {
  it('opens the source a notification names', () => {
    const next = actions();

    handleDesktopNavigation({ kind: 'source', type: 'youtube', id: 'subscription-a' }, next);

    expect(next.openSource).toHaveBeenCalledWith('youtube', 'subscription-a');
    expect(next.navigate).not.toHaveBeenCalled();
  });

  it('shows a message instead of navigating', () => {
    const next = actions();

    handleDesktopNavigation({ kind: 'message', message: '這個訂閱已移除。' }, next);

    expect(next.announce).toHaveBeenCalledWith('這個訂閱已移除。');
    expect(next.openSource).not.toHaveBeenCalled();
  });
});
