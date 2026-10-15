const MASK = '[已遮蔽]';

/**
 * Credentials that can appear in error output: authorization headers, bearer tokens, cookies and
 * secret-bearing URL parameters. Each pattern keeps its label so the reader still sees what was there.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/\b(authorization|proxy-authorization)\s*[:=]\s*(?:(?:bearer|basic|token)\s+)?[A-Za-z0-9._~+/=:-]+/giu, `$1: ${MASK}`],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]+/giu, `Bearer ${MASK}`],
  [/\b(set-cookie|cookie)\s*[:=][^\r\n]*/giu, `$1: ${MASK}`],
  [/([?&#;](?:access_token|refresh_token|token|key|api_key|apikey|sig|signature|auth|password|session)=)[^&#\s"']*/giu, `$1${MASK}`],
];

/** Secrets shorter than this are not matched literally; they would mask ordinary words. */
const MIN_SECRET_LENGTH = 8;

/** Masks credentials in `text`, including every literal occurrence of the given secrets. */
export function redact(text: string, secrets: Iterable<string> = []): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH) result = result.split(secret).join(MASK);
  }
  for (const [pattern, replacement] of PATTERNS) result = result.replace(pattern, replacement);
  return result;
}

/**
 * Shortens text to `max` characters. Messages keep their beginning; diagnostic output keeps its end,
 * where tools print the error that stopped them.
 */
export function limitText(text: string, max: number, keep: 'head' | 'tail'): string {
  const characters = [...text];
  if (characters.length <= max) return text;
  return keep === 'head'
    ? `${characters.slice(0, max - 1).join('')}…`
    : `…${characters.slice(characters.length - (max - 1)).join('')}`;
}
