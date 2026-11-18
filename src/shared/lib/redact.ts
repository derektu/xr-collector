/**
 * Masking of credentials in text the app writes to a file or hands to the UI, an Agent or the OS.
 * Messages that can carry output of other programs (job errors, activity events, notifications,
 * system notifications, error answers) pass through `redact` where they are made: the credential
 * patterns below plus every literal secret the process holds, such as the Agent token and the search
 * engine key. The HTTP listeners also mask the literal secrets in every answer and event they send
 * (`maskSecrets`, `maskSecretsJson`); the patterns stay out of that exit, since document text and
 * feed addresses legitimately contain words such as "bearer" or a `?key=` parameter.
 *
 * The secrets are kept for the whole process. The Agent token is protected when it is loaded and when
 * it is reset; the search engine generates a new key each time it starts and protects it then. A
 * secret replaced later stays masked, since older text can still carry it.
 */
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

const secrets = new Set<string>();

/** Masks `secret` wherever it appears in text passed to `redact` from now on. */
export function protectSecret(secret: string): void {
  if (secret.length >= MIN_SECRET_LENGTH) secrets.add(secret);
}

/** Masks every literal occurrence of a protected secret in `text`. */
export function maskSecrets(text: string): string {
  let result = text;
  for (const secret of secrets) result = result.split(secret).join(MASK);
  return result;
}

/** Masks credentials in `text`: every literal occurrence of a protected secret, then the credential patterns. */
export function redact(text: string): string {
  let result = maskSecrets(text);
  for (const [pattern, replacement] of PATTERNS) result = result.replace(pattern, replacement);
  return result;
}

/** `value` as JSON text with every string value passed through `maskSecrets`. */
export function maskSecretsJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === 'string' ? maskSecrets(item) : item);
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
