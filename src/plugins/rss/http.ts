import { CollectorError } from '../../core/types.js';

/** A fetched document: the address it came from after redirects, and its text. */
export interface FetchedText {
  url: string;
  text: string;
}

/** A request gives up after this long. */
export const FETCH_TIMEOUT_MS = 20_000;
/** Feeds and pages larger than this are not read. */
export const MAX_BYTES = 5 * 1024 * 1024;

const ACCEPT = 'application/rss+xml, application/atom+xml, application/rdf+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5';

/**
 * Fetches a feed or web page. Failures raise the RSS error codes: `network_error` for a connection
 * failure, a timeout or a server error, `rate_limited` for HTTP 429, `feed_not_found` for 404 and
 * 410, and `feed_unavailable` for any other refusal and for a body over `MAX_BYTES`. The text is
 * decoded with the charset the response or the document declares, UTF-8 otherwise. Aborting
 * `signal` rejects with its reason.
 */
export async function fetchText(url: string, signal?: AbortSignal): Promise<FetchedText> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: ACCEPT, 'user-agent': 'XR-Collector (RSS reader)' },
      redirect: 'follow',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new CollectorError('network_error', '無法連線到這個網站，請稍後再試。', { cause: error });
  }
  if (response.status === 429) throw new CollectorError('rate_limited', '這個網站暫時限制連線。');
  if (response.status === 404 || response.status === 410) throw new CollectorError('feed_not_found', '找不到這個 feed。');
  if (response.status >= 500) throw new CollectorError('network_error', `網站暫時無法回應（HTTP ${response.status}）。`);
  if (!response.ok) throw new CollectorError('feed_unavailable', `網站拒絕讀取（HTTP ${response.status}）。`);
  let bytes: Uint8Array;
  try {
    bytes = await readLimited(response);
  } catch (error) {
    if (error instanceof CollectorError) throw error;
    if (signal?.aborted) throw signal.reason;
    throw new CollectorError('network_error', '讀取網站內容時連線中斷。', { cause: error });
  }
  return { url: response.url || url, text: decode(bytes, response.headers.get('content-type')) };
}

async function readLimited(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new CollectorError('feed_unavailable', '這個網址的內容太大，無法讀取。');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Decodes with the charset of the Content-Type header, else of the XML declaration or an HTML meta tag, else UTF-8. */
export function decode(bytes: Uint8Array, contentType: string | null): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  const charset = contentType?.match(/charset=["']?([\w-]+)/iu)?.[1]
    ?? head.match(/<\?xml[^>]*encoding=["']([\w-]+)["']/iu)?.[1]
    ?? head.match(/<meta[^>]*charset=["']?([\w-]+)/iu)?.[1]
    ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}
