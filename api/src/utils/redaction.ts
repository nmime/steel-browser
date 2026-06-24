const REDACTED = "[REDACTED]";

const DEFAULT_SENSITIVE_KEYS = [
  "authorization",
  "api_key",
  "session_token",
  "refresh_token",
  "jwt",
  "api-key",
  "x-api-key",
  "apikey",
  "access_token",
  "auth_token",
  "client_secret",
  "cookie",
  "password",
  "proxy_url",
  "secret",
  "set-cookie",
  "token",
];

const DEFAULT_SENSITIVE_KEY_PATTERNS = DEFAULT_SENSITIVE_KEYS.map(
  (key) => new RegExp(`(^|[_-])${key.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}($|[_-])`, "i"),
);

export function isSensitiveKey(key: string): boolean {
  return DEFAULT_SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export function redactUrl(value: string): string {
  const parsedUrl = parseUrl(value);
  if (!parsedUrl) return value;

  const { url, isRelative } = parsedUrl;

  if (url.username || url.password) {
    url.username = REDACTED;
    url.password = REDACTED;
  }

  for (const key of Array.from(url.searchParams.keys())) {
    if (isSensitiveKey(key)) {
      url.searchParams.set(key, REDACTED);
    }
  }

  if (isRelative) {
    return formatRedactedUrl(`${url.pathname}${url.search}${url.hash}`);
  }

  return formatRedactedUrl(url.toString());
}

export function redactSensitiveData<T>(value: T): T {
  return redactValue(value, new WeakSet<object>()) as T;
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactUrl(value);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      isSensitiveKey(key) ? REDACTED : redactValue(entry, seen),
    ]),
  );
}

function formatRedactedUrl(value: string): string {
  return value.replaceAll(encodeURIComponent(REDACTED), REDACTED);
}

function parseUrl(value: string): { url: URL; isRelative: boolean } | null {
  try {
    return { url: new URL(value), isRelative: false };
  } catch {
    if (!value.startsWith("/") && !value.startsWith("?")) {
      return null;
    }

    try {
      return { url: new URL(value, "http://steel.local"), isRelative: true };
    } catch {
      return null;
    }
  }
}

export { REDACTED };
