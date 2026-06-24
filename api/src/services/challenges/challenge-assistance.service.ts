import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  ChallengeDetectionBody,
  ChallengeReportBody,
  ManualHandoffBody,
  OwnedTestAutoBody,
  OwnedTestCallbackBody,
  ChallengeAssistanceResponse,
} from "../../modules/challenges/challenges.schema.js";

type ChallengeKind = NonNullable<ChallengeAssistanceResponse["challenge"]>["kind"];
type ChallengeAssistanceMode = NonNullable<ChallengeAssistanceResponse["ownedTestAuto"]>["mode"];
type OwnedTestAutoElement = OwnedTestAutoBody["elements"][number];
type OwnedTestAutoAction = NonNullable<
  NonNullable<ChallengeAssistanceResponse["ownedTestAuto"]>["actions"]
>[number];

export type ChallengeAssistanceConfig = {
  enabled: boolean;
  mode?: ChallengeAssistanceMode;
  allowedOrigins: string | string[];
  ownedTestCallbackSecret?: string;
  ownedTestCallbackMaxSkewMs?: number;
};

export const CHALLENGE_SAFE_HANDLING = [
  "Challenge assistance is disabled by default and only accepts exact-origin allowlisted URLs.",
  "This service records redacted diagnostics and can request manual handoff; it does not automate third-party or real-world challenge completion.",
  'Owned-test auto mode is only for synthetic diploma/testing harness pages marked with data-steel-owned-challenge="true".',
  "Do not send cookies, authorization headers, page HTML, images, audio, challenge tokens, or provider payloads.",
];

const OWNED_TEST_PROVIDER = "owned-test-auto" as const;
const OWNED_TEST_MARKER_ATTR = "data-steel-owned-challenge";
const OWNED_TEST_FIELD_ATTR = "data-steel-owned-challenge-field";
const OWNED_TEST_VALUE_ATTR = "data-steel-owned-challenge-value";
const OWNED_TEST_SUBMIT_ATTR = "data-steel-owned-challenge-submit";
const OWNED_TEST_CLICK_ATTR = "data-steel-owned-challenge-click";

const OWNED_TEST_SAFETY_CHECKS = [
  "exact-origin allowlist matched",
  "owned marker attribute required",
  "known real challenge widgets/classes/sitekeys rejected",
  "only safe fill/click actions from owned data attributes are returned",
  "no cookies, page HTML, screenshots, tokens, or provider payloads accepted",
];

const SECRET_KEY_PATTERN = /(cookie|authorization|password|secret|token|key|credential|session)/i;
const TOKEN_LIKE_PATTERN = /\b(?:bearer\s+)?[A-Za-z0-9._~+/=-]{24,}\b/g;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_PATTERN = /\+?\b\d[\d(). -]{7,}\d\b/g;
const REAL_CHALLENGE_ATTR_PATTERN = /(^|[-_])(sitekey|response|enterprise)([-_]|$)/i;
const REAL_CHALLENGE_WIDGET_PATTERN =
  /\b(g-recaptcha|grecaptcha|h-captcha|hcaptcha|cf-turnstile|turnstile|challenges\.cloudflare\.com|recaptcha\/|api2\/anchor)\b/i;

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

const normalizeMode = (mode: ChallengeAssistanceMode | undefined): ChallengeAssistanceMode =>
  mode ?? "off";

const readAttribute = (element: OwnedTestAutoElement, name: string): string | undefined => {
  const entries = Object.entries(element.attributes ?? {});
  const match = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
  return normalizeText(match?.[1], 512);
};

const hasOwnedTestMarker = (element: OwnedTestAutoElement): boolean =>
  readAttribute(element, OWNED_TEST_MARKER_ATTR)?.toLowerCase() === "true";

const isTruthyAttribute = (element: OwnedTestAutoElement, name: string): boolean => {
  const value = readAttribute(element, name)?.toLowerCase();
  return value === "true" || value === "1" || value === "yes";
};

const hasKnownRealChallengeSignal = (element: OwnedTestAutoElement): boolean => {
  const selector = normalizeText(element.selector, 512) ?? "";
  const tagName = normalizeText(element.tagName, 64) ?? "";
  const text = normalizeText(element.text, 512) ?? "";
  const attributeText = Object.entries(element.attributes ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");

  if (Object.keys(element.attributes ?? {}).some((key) => REAL_CHALLENGE_ATTR_PATTERN.test(key))) {
    return true;
  }

  return REAL_CHALLENGE_WIDGET_PATTERN.test(`${selector} ${tagName} ${text} ${attributeText}`);
};

const buildOwnedTestAutoActions = (input: OwnedTestAutoBody): OwnedTestAutoAction[] => {
  const actions: OwnedTestAutoAction[] = [];

  for (const element of input.elements) {
    if (!hasOwnedTestMarker(element)) continue;

    const selector = normalizeText(element.selector, 512);
    if (!selector) continue;

    const field = readAttribute(element, OWNED_TEST_FIELD_ATTR);
    if (field) {
      const configuredValue = input.fieldValues?.[field];
      const attributeValue = readAttribute(element, OWNED_TEST_VALUE_ATTR);
      const value = normalizeText(configuredValue ?? attributeValue, 256);
      if (value) {
        actions.push({ type: "fill", selector, field, value });
      }
    }

    if (
      isTruthyAttribute(element, OWNED_TEST_SUBMIT_ATTR) ||
      isTruthyAttribute(element, OWNED_TEST_CLICK_ATTR)
    ) {
      actions.push({ type: "click", selector });
    }
  }

  return actions.slice(0, 20);
};

export class ChallengeAssistanceService {
  private readonly enabled: boolean;
  private readonly mode: ChallengeAssistanceMode;
  private readonly allowedOrigins: string[];
  private readonly ownedTestCallbackSecret?: string;
  private readonly ownedTestCallbackMaxSkewMs: number;

  constructor(config: ChallengeAssistanceConfig) {
    this.mode = normalizeMode(config.mode);
    this.enabled = config.enabled || this.mode !== "off";
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

  runOwnedTestAuto(input: OwnedTestAutoBody): ChallengeAssistanceResponse {
    const gate = this.requireEnabledAllowed(input.url);
    if (gate) {
      return {
        ...gate,
        ownedTestAuto: {
          provider: OWNED_TEST_PROVIDER,
          mode: this.mode,
          status: gate.status === "disabled" ? "disabled" : "rejected",
          reason: gate.status,
          scannedElements: input.elements.length,
          safetyChecks: OWNED_TEST_SAFETY_CHECKS,
        },
      };
    }

    const allowedOrigin = parseOrigin(input.url);
    const redacted = { url: redactUrl(input.url) };

    if (this.mode !== "owned-test-auto") {
      return response("owned_test_auto_rejected", this.enabled, {
        allowedOrigin,
        redacted,
        error:
          "Owned-test auto provider is disabled. Set CHALLENGE_ASSISTANCE_MODE=owned-test-auto for testing harness pages only.",
        ownedTestAuto: {
          provider: OWNED_TEST_PROVIDER,
          mode: this.mode,
          status: "disabled",
          reason: "mode_not_owned_test_auto",
          scannedElements: input.elements.length,
          safetyChecks: OWNED_TEST_SAFETY_CHECKS,
        },
      });
    }

    if (input.elements.some(hasKnownRealChallengeSignal)) {
      return response("owned_test_auto_rejected", this.enabled, {
        allowedOrigin,
        redacted,
        error:
          "Known real challenge widget, class, or sitekey signal detected; owned-test auto refused.",
        ownedTestAuto: {
          provider: OWNED_TEST_PROVIDER,
          mode: this.mode,
          status: "rejected",
          reason: "known_real_challenge_signal_detected",
          scannedElements: input.elements.length,
          safetyChecks: OWNED_TEST_SAFETY_CHECKS,
        },
      });
    }

    if (!input.elements.some(hasOwnedTestMarker)) {
      return response("owned_test_auto_rejected", this.enabled, {
        allowedOrigin,
        redacted,
        error: `No ${OWNED_TEST_MARKER_ATTR}=\"true\" marker found in sanitized test harness elements.`,
        ownedTestAuto: {
          provider: OWNED_TEST_PROVIDER,
          mode: this.mode,
          status: "rejected",
          reason: "owned_marker_missing",
          scannedElements: input.elements.length,
          safetyChecks: OWNED_TEST_SAFETY_CHECKS,
        },
      });
    }

    const actions = buildOwnedTestAutoActions(input);
    if (!actions.length) {
      return response("owned_test_auto_rejected", this.enabled, {
        allowedOrigin,
        redacted,
        error:
          "Owned marker found, but no safe owned field or click action attributes were provided.",
        ownedTestAuto: {
          provider: OWNED_TEST_PROVIDER,
          mode: this.mode,
          status: "rejected",
          reason: "owned_actions_missing",
          scannedElements: input.elements.length,
          safetyChecks: OWNED_TEST_SAFETY_CHECKS,
        },
      });
    }

    return response("owned_test_auto_ready", this.enabled, {
      allowedOrigin,
      redacted,
      challenge: {
        suspected: true,
        kind: "bot_check",
        provider: OWNED_TEST_PROVIDER,
        indicators: ["owned test marker"],
      },
      ownedTestAuto: {
        provider: OWNED_TEST_PROVIDER,
        mode: this.mode,
        status: "ready",
        scannedElements: input.elements.length,
        actions,
        safetyChecks: OWNED_TEST_SAFETY_CHECKS,
      },
    });
  }

  private requireEnabledAllowed(url: string): ChallengeAssistanceResponse | undefined {
    if (!this.enabled) {
      return response("disabled", this.enabled, {
        error:
          "Challenge assistance is disabled. Set CHALLENGE_ASSISTANCE_ENABLED=true or CHALLENGE_ASSISTANCE_MODE=owned-test-auto to enable testing-only assistance.",
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
