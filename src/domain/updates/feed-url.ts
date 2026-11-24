/**
 * The update feed URL `value` names, for a generic electron-updater feed: HTTPS, or HTTP on
 * 127.0.0.1 or localhost for local acceptance, without credentials, query or fragment.
 */
export function updateFeedUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('The update feed URL cannot contain credentials, a query or a fragment.');
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('The update feed URL must use HTTPS; HTTP is allowed only on 127.0.0.1 or localhost.');
  }
  return url.href;
}
