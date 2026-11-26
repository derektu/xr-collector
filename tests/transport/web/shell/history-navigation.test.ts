import { describe, expect, it } from 'vitest';
import { backTarget, openedFromSource, readAppHistoryState } from '../../../../src/transport/web/shell/history-navigation.js';

describe('Back controls', () => {
  it('Back returns through an entry the app pushed and goes to the fallback page when the page was opened directly', () => {
    expect(backTarget(readAppHistoryState({ returnable: true }), '/documents')).toEqual({ kind: 'history' });
    expect(backTarget(readAppHistoryState(null), '/documents')).toEqual({ kind: 'go', path: '/documents', replace: false });
    expect(backTarget(readAppHistoryState({ documentsScroll: 120 }), '/')).toEqual({ kind: 'go', path: '/', replace: false });
    expect(backTarget(readAppHistoryState({ returnable: 'yes' }), '/documents')).toEqual({ kind: 'go', path: '/documents', replace: false });
  });

  it('Back from a page that no longer exists replaces its entry instead of pushing a new one', () => {
    expect(backTarget(readAppHistoryState(null), '/', true)).toEqual({ kind: 'go', path: '/', replace: true });
    expect(backTarget(readAppHistoryState({ returnable: true }), '/', true)).toEqual({ kind: 'history' });
  });

  it('a document counts as opened from a subscription only when the subscription page pushed its entry', () => {
    expect(openedFromSource(readAppHistoryState({ returnable: true, from: 'source', documentsScroll: 0 }))).toBe(true);
    expect(openedFromSource(readAppHistoryState({ returnable: true }))).toBe(false);
    expect(openedFromSource(readAppHistoryState({ from: 'source' }))).toBe(false);
    expect(openedFromSource(readAppHistoryState({ returnable: 'yes', from: 'source' }))).toBe(false);
  });
});
