const MASK = '[已遮蔽]';

const PATTERNS: Array<[RegExp, string]> = [
  [/\b(authorization|proxy-authorization)\s*[:=]\s*(?:(?:bearer|basic|token)\s+)?[A-Za-z0-9._~+/=:-]+/giu, `$1: ${MASK}`],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]+/giu, `Bearer ${MASK}`],
  [/\b(set-cookie|cookie)\s*[:=][^\r\n]*/giu, `$1: ${MASK}`],
  [/([?&#;](?:access_token|refresh_token|token|key|api_key|apikey|sig|signature|auth|password|session)=)[^&#\s"']*/giu, `$1${MASK}`],
];

const MIN_SECRET_LENGTH = 8;

const secrets = new Set<string>();

/** Masks `secret` wherever it appears in text passed to `redact`, `maskSecrets` or `maskSecretsJson` from now on. */
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

/** Shortens text to `max` characters. */
export function limitText(text: string, max: number, keep: 'head' | 'tail'): string {
  const characters = [...text];
  if (characters.length <= max) return text;
  return keep === 'head'
    ? `${characters.slice(0, max - 1).join('')}…`
    : `…${characters.slice(characters.length - (max - 1)).join('')}`;
}
