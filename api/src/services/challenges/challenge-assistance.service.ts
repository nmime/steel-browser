import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  ChallengeDetectionBody,
  ChallengeReportBody,
  ManualHandoffBody,
  OwnedTestCallbackBody,
  ChallengeAssistanceResponse,
} from "../../modules/challenges/challenges.schema.js";

type ChallengeKind = NonNullable<ChallengeAssistanceResponse["challenge"]>["kind"];

export type ChallengeAssistanceConfig = {
  enabled: boolean;
  allowedOrigins: string | string[];
  ownedTestCallbackSecret?: string;
  ownedTestCallbackMaxSkewMs?: number;
};

export const CHALLENGE_SAFE_HANDLING = [
  "Challenge assistance is disabled by default and only accepts exact-origin allowlisted URLs.",
  "This service records redacted diagnostics and can request manual handoff; it does not automate challenge completion.",
  "Do not send cookies, authorization headers, page HTML, images, audio, challenge tokens, or provider payloads.",
];

const SECRET_KEY_PATTERN = /(cookie|authorization|password|secret|token|key|credential|session)/i;
const TOKEN_LIKE_PATTERN = /\b(?:bearer\s+)?[A-Za-z0-9._~+/=-]{24,}\b/g;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_PATTERN = /\+?\b\d[\d(). -]{7,}\d\b/g;

const normalizeText = (value: unknown, maxLength: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;

  const redacted = normalized
    .replace(EMAIL_PATTERN, "[REDACTED_EMAIL]")
    .replace(PHONE_PATTERN, "[REDACTED_PHONE]")
    .replace(TOKEN_LIKE_PATTERN, "[REDACTED_TOKEN]");

  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, Math.max(0, maxLength - 3))}...`;
};

export const redactUrl = (url: string): string => {
  const parsed = new URL(url);
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
};

export const normalizeAllowedOrigins = (allowedOrigins: string | string[]): string[] => {
  const values = Array.isArray(allowedOrigins) ? allowedOrigins : allowedOrigins.split(",");

  return Array.from(
    new Set(
      values.flatMap((value) => {
        const trimmed = value.trim();
        if (!trimmed) return [];
        try {
          const parsed = new URL(trimmed);
          if (parsed.username || parsed.password || parsed.search || parsed.hash) return [];
          if (parsed.pathname !== "/" && parsed.pathname !== "") return [];
          return [parsed.origin];
        } catch {
          return [];
        }
      }),
    ),
  );
};

const redactMetadata = (
  metadata: Record<string, string | number | boolean> | undefined,
): Record<string, string | number | boolean> | undefined => {
  if (!metadata) return undefined;

  const redacted = Object.entries(metadata).reduce<Record<string, string | number | boolean>>(
    (acc, [key, value]) => {
      if (SECRET_KEY_PATTERN.test(key)) {
        acc[key] = "[REDACTED]";
        return acc;
      }

      if (typeof value === "string") {
        acc[key] = normalizeText(value, 256) ?? "";
        return acc;
      }

      acc[key] = value;
      return acc;
    },
    {},
  );

  return Object.keys(redacted).length ? redacted : undefined;
};

const parseOrigin = (url: string): string => new URL(url).origin;

const detectKind = (
  input: ChallengeDetectionBody,
): { kind: ChallengeKind; indicators: string[] } => {
  const haystack = [input.title, input.visibleText, ...(input.indicators ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const matches: Array<{ kind: ChallengeKind; pattern: RegExp; label: string }> = [
    {
      kind: "captcha",
      pattern: /\b(captcha|hcaptcha|recaptcha|turnstile)\b/,
      label: "captcha marker",
    },
    {
      kind: "bot_check",
      pattern: /(verify you are human|checking your browser|one more step|security check)/,
      label: "human verification text",
    },
    {
      kind: "login_mfa",
      pattern: /(multi-factor|two-factor|verification code|mfa)/,
      label: "MFA text",
    },
    {
      kind: "rate_limit",
      pattern: /(rate limit|too many requests|unusual traffic)/,
      label: "rate limit text",
    },
  ];

  const found = matches.find(({ pattern }) => pattern.test(haystack));
  return found
    ? { kind: found.kind, indicators: [found.label] }
    : { kind: "unknown", indicators: [] };
};

const response = (
  status: ChallengeAssistanceResponse["status"],
  enabled: boolean,
  partial: Omit<
    Partial<ChallengeAssistanceResponse>,
    "status" | "assistanceEnabled" | "safeHandling"
  > = {},
): ChallengeAssistanceResponse => ({
  status,
  assistanceEnabled: enabled,
  safeHandling: CHALLENGE_SAFE_HANDLING,
  ...partial,
});

export class ChallengeAssistanceService {
  private readonly enabled: boolean;
  private readonly allowedOrigins: string[];
  private readonly ownedTestCallbackSecret?: string;
  private readonly ownedTestCallbackMaxSkewMs: number;

  constructor(config: ChallengeAssistanceConfig) {
    this.enabled = config.enabled;
    this.allowedOrigins = normalizeAllowedOrigins(config.allowedOrigins);
    this.ownedTestCallbackSecret = config.ownedTestCallbackSecret;
    this.ownedTestCallbackMaxSkewMs = config.ownedTestCallbackMaxSkewMs ?? 5 * 60 * 1000;
  }

  detectChallenge(input: ChallengeDetectionBody): ChallengeAssistanceResponse {
    const gate = this.requireEnabledAllowed(input.url);
    if (gate) return gate;

    const detected = detectKind(input);
    return response("detected", this.enabled, {
      allowedOrigin: parseOrigin(input.url),
      challenge: {
        suspected: detected.kind !== "unknown",
        kind: detected.kind,
        indicators: detected.indicators,
      },
      redacted: {
        url: redactUrl(input.url),
        title: normalizeText(input.title, 256),
        visibleText: normalizeText(input.visibleText, 512),
      },
    });
  }

  reportChallenge(input: ChallengeReportBody): ChallengeAssistanceResponse {
    const gate = this.requireEnabledAllowed(input.url);
    if (gate) return gate;

    const detected = detectKind(input);
    const provider = normalizeText(input.provider, 128);
    const kind = input.kind ?? detected.kind;

    return response("reported", this.enabled, {
      allowedOrigin: parseOrigin(input.url),
      reportId: `challenge_${randomUUID()}`,
      challenge: {
        suspected: true,
        kind,
        provider,
        indicators: detected.indicators,
      },
      redacted: {
        url: redactUrl(input.url),
        title: normalizeText(input.title, 256),
        visibleText: normalizeText(input.visibleText, 512),
        metadata: redactMetadata(input.metadata),
      },
    });
  }

  requestManualHandoff(input: ManualHandoffBody): ChallengeAssistanceResponse {
    const gate = this.requireEnabledAllowed(input.url);
    if (gate) return gate;

    const challengeId = input.challengeId ?? `manual_${randomUUID()}`;
    const expiresAt = input.expiresInSeconds
      ? new Date(Date.now() + input.expiresInSeconds * 1000).toISOString()
      : undefined;

    return response("manual_handoff_required", this.enabled, {
      allowedOrigin: parseOrigin(input.url),
      redacted: {
        url: redactUrl(input.url),
        visibleText: normalizeText(input.reason, 512),
      },
      manualHandoff: {
        challengeId,
        message:
          "Manual handoff required. A human operator should complete any challenge directly in the browser session; no automated completion is attempted.",
        expiresAt,
      },
    });
  }

  handleOwnedTestCallback(
    input: OwnedTestCallbackBody,
    payload: string,
    timestamp: string | undefined,
    signature: string | undefined,
  ): ChallengeAssistanceResponse {
    const gate = this.requireEnabledAllowed(input.url);
    if (gate) return gate;

    if (!this.ownedTestCallbackSecret) {
      return response("callback_secret_not_configured", this.enabled, {
        allowedOrigin: parseOrigin(input.url),
        error: "Owned-test callback HMAC secret is not configured.",
      });
    }

    if (!this.isValidSignature(payload, timestamp, signature)) {
      return response("invalid_signature", this.enabled, {
        allowedOrigin: parseOrigin(input.url),
        error: "Invalid owned-test callback HMAC signature.",
      });
    }

    return response("callback_accepted", this.enabled, {
      allowedOrigin: parseOrigin(input.url),
      reportId: input.challengeId ?? input.testId,
      redacted: {
        url: redactUrl(input.url),
        metadata: redactMetadata(input.metadata),
      },
    });
  }

  private requireEnabledAllowed(url: string): ChallengeAssistanceResponse | undefined {
    if (!this.enabled) {
      return response("disabled", this.enabled, {
        error:
          "Challenge assistance is disabled. Set CHALLENGE_ASSISTANCE_ENABLED=true to enable this skeleton.",
      });
    }

    const origin = parseOrigin(url);
    if (!this.allowedOrigins.includes(origin)) {
      return response("origin_not_allowed", this.enabled, {
        allowedOrigin: origin,
        error: "URL origin is not exactly allowlisted for challenge assistance.",
      });
    }

    return undefined;
  }

  private isValidSignature(
    payload: string,
    timestamp: string | undefined,
    signature: string | undefined,
  ): boolean {
    if (!timestamp || !signature || !this.ownedTestCallbackSecret) return false;

    const timestampMs = Number(timestamp);
    if (!Number.isFinite(timestampMs)) return false;
    if (Math.abs(Date.now() - timestampMs) > this.ownedTestCallbackMaxSkewMs) return false;

    const supplied = signature.replace(/^sha256=/, "").trim();
    const expected = createHmac("sha256", this.ownedTestCallbackSecret)
      .update(`${timestamp}.${payload}`)
      .digest("hex");

    const suppliedBuffer = Buffer.from(supplied, "hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    return (
      suppliedBuffer.length === expectedBuffer.length &&
      timingSafeEqual(suppliedBuffer, expectedBuffer)
    );
  }
}

export const createChallengeAssistanceService = (config: ChallengeAssistanceConfig) =>
  new ChallengeAssistanceService(config);
