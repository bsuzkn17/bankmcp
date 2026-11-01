const REDACTED = '[REDACTED]';
const IBAN_PATTERN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/gi;
const CARD_PATTERN = /\b(?:\d[ -]*?){13,19}\b/g;
const JWT_PATTERN =
  /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;

export function maskIban(iban: string): string {
  const compactIban = iban.replace(/\s+/g, '');
  const prefix = compactIban.slice(0, 4);
  const suffix = compactIban.slice(-4);
  const maskedLength = Math.max(compactIban.length - 8, 0);

  return `${prefix}${'*'.repeat(maskedLength)}${suffix}`;
}

export function maskCardNumber(pan: string): string {
  const digits = pan.replace(/\D/g, '');
  const lastFour = digits.slice(-4);

  return `**** **** **** ${lastFour}`;
}

export function maskTckn(tckn: string): string {
  const digits = tckn.replace(/\D/g, '');
  const lastTwo = digits.slice(-2);

  return `${'*'.repeat(Math.max(digits.length - 2, 0))}${lastTwo}`;
}

export function sanitizeText(input: string): string {
  return input
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(JWT_PATTERN, REDACTED)
    .replace(IBAN_PATTERN, maskIban)
    .replace(CARD_PATTERN, (match) => maskCardNumber(match));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
  return /(?:access_token|refresh_token|client_secret|password|authorization|token|secret|apikey)/i.test(
    key,
  );
}

function sanitizeValue(
  value: unknown,
  key: string,
  depth: number,
  maxDepth: number,
  seen: WeakSet<object>,
): unknown {
  if (isSensitiveKey(key)) {
    return REDACTED;
  }

  if (typeof value === 'string') {
    if (/iban/i.test(key)) {
      return maskIban(value);
    }
    if (/(?:card|pan)/i.test(key)) {
      return maskCardNumber(value);
    }
    if (/(?:tckn|identity)/i.test(key)) {
      return maskTckn(value);
    }
    return sanitizeText(value);
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  if (depth >= maxDepth || seen.has(value)) {
    return REDACTED;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) =>
      sanitizeValue(item, '', depth + 1, maxDepth, seen),
    );
  }

  if (isRecord(value)) {
    const sanitized: Record<string, unknown> = {};
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      sanitized[nestedKey] = sanitizeValue(
        nestedValue,
        nestedKey,
        depth + 1,
        maxDepth,
        seen,
      );
    }
    return sanitized;
  }

  return REDACTED;
}

export function sanitizeData<T>(data: T, maxDepth = 6): unknown {
  const safeMaxDepth =
    Number.isInteger(maxDepth) && maxDepth >= 0 ? maxDepth : 6;

  return sanitizeValue(data, '', 0, safeMaxDepth, new WeakSet<object>());
}
