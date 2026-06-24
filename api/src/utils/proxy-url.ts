const DEFAULT_PROXY_PROTOCOL = "http://";

export interface ProxyCredentialsConfig {
  username?: string;
  password?: string;
}

export interface ProxyConfig extends ProxyCredentialsConfig {
  url?: string;
}

function withDefaultProtocol(proxyUrl: string): string {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(proxyUrl)
    ? proxyUrl
    : `${DEFAULT_PROXY_PROTOCOL}${proxyUrl}`;
}

function stripEmptyRootPath(proxyUrl: URL): string {
  const serialized = proxyUrl.toString();
  if (proxyUrl.pathname === "/" && !proxyUrl.search && !proxyUrl.hash) {
    return serialized.replace(/\/$/, "");
  }
  return serialized;
}

export function normalizeProxyUrl(proxyUrl: string): string {
  const candidate = proxyUrl.trim();
  if (!candidate) {
    throw new Error("Proxy URL must not be empty");
  }

  try {
    const parsed = new URL(withDefaultProtocol(candidate));
    if (!parsed.hostname) {
      throw new Error("Proxy URL must include a host");
    }
    return stripEmptyRootPath(parsed);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Proxy URL")) {
      throw error;
    }
    throw new Error("Invalid proxy URL format");
  }
}

export function applyProxyCredentials(
  proxyUrl: string,
  credentials: ProxyCredentialsConfig = {},
): string {
  const normalized = normalizeProxyUrl(proxyUrl);
  const parsed = new URL(normalized);

  if (!parsed.username && !parsed.password && credentials.username) {
    parsed.username = credentials.username;
    parsed.password = credentials.password ?? "";
  }

  return stripEmptyRootPath(parsed);
}

export function resolveProxyUrl(
  proxyUrl?: string | null,
  config: ProxyConfig = {},
): string | undefined {
  if (proxyUrl === null) {
    return undefined;
  }

  const candidate = proxyUrl?.trim() || config.url?.trim();
  if (!candidate) {
    return undefined;
  }

  return applyProxyCredentials(candidate, {
    username: config.username,
    password: config.password,
  });
}

export function redactProxyUrl(proxyUrl?: string): string | undefined {
  if (!proxyUrl) {
    return proxyUrl;
  }

  try {
    const parsed = new URL(normalizeProxyUrl(proxyUrl));
    if (parsed.username || parsed.password) {
      parsed.username = "redacted";
      parsed.password = "redacted";
    }
    return stripEmptyRootPath(parsed);
  } catch {
    return proxyUrl.replace(/(\/\/)([^/@\s:]+)(?::[^/@\s]*)?@/, "$1redacted:redacted@");
  }
}
