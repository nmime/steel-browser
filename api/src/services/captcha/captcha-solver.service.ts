/**
 * CaptchaSolverService — the authorization gate + provider orchestration.
 *
 * The gate is the whole point of the "gated" design: solving only runs when
 * BOTH are true —
 *   1. CAPTCHA_SOLVER_ENABLED=true (explicit opt-in), and
 *   2. the target page's origin is in the exact-origin allowlist
 *      (unless CAPTCHA_SOLVER_ALLOW_ANY_ORIGIN=true, an opt-in wildcard mode
 *      that bypasses the allowlist but still requires the master flag and is
 *      logged on every authorized solve).
 * Otherwise every method returns `disabled` / `origin_not_allowed` and does
 * no network I/O and no page I/O. The origin normalization is shared with the
 * challenge-assistance service for consistency.
 *
 * The mode (`off | detect-only | auto`) is a second control: `detect-only`
 * permits inspection (`/detect`) but blocks solving (`/solve`) so an operator
 * can dry-run detection without ever spending money or calling a provider.
 */
import type { FastifyBaseLogger } from "fastify";
import type {
  CaptchaSolverMode,
  CaptchaSolverProvider,
  CaptchaSolverProviderType,
  CaptchaWidgetDescriptor,
  SolveResult,
} from "./captcha-provider.js";
import {
  CaptchaSolverError,
  CaptchaUnsupportedWidgetError,
  isImageType,
} from "./captcha-provider.js";
import { AntiCaptchaProvider } from "./anti-captcha-provider.js";
import { CapMonsterProvider } from "./capmonster-provider.js";
import { CapSolverProvider } from "./capsolver-provider.js";
import { TwoCaptchaProvider } from "./two-captcha-provider.js";
import { normalizeAllowedOrigins } from "../challenges/challenge-assistance.service.js";

export interface CaptchaSolverConfig {
  enabled: boolean;
  mode?: CaptchaSolverMode;
  provider: CaptchaSolverProviderType;
  apiKey?: string;
  allowedOrigins: string | string[];
  allowAnyOrigin?: boolean;
  timeoutMs: number;
  pollIntervalMs: number;
}

/** How the origin gate authorized (or refused) a request. */
export type OriginMode = "allowlist" | "wildcard";

export interface SolveOutcome {
  status:
    | "solved"
    | "disabled"
    | "detect_only"
    | "origin_not_allowed"
    | "not_configured"
    | "solver_error";
  token?: string;
  text?: string;
  coordinates?: Array<{ x: number; y: number }>;
  angle?: number;
  providerTaskId?: string;
  provider?: CaptchaSolverProviderType;
  costUsd?: number;
  durationMs?: number;
  allowedOrigin?: string;
  mode?: CaptchaSolverMode;
  originMode?: OriginMode;
  redacted: { url: string };
  error?: string;
  errorCode?: string;
}

export const CAPTCHA_SOLVER_SAFE_HANDLING = [
  "Captcha solving is disabled by default and only runs against exact-origin allowlisted URLs (or an explicit, logged wildcard mode).",
  "Only list origins you are authorized to automate; respect each site's terms and rate limits.",
  "API keys are never returned in responses; solver errors are reported without credentials.",
];

const parseOrigin = (url: string): string => new URL(url).origin;

const redactUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
};

export class CaptchaSolverService {
  private readonly enabled: boolean;
  private readonly mode: CaptchaSolverMode;
  private readonly allowedOrigins: string[];
  private readonly allowAnyOrigin: boolean;
  private readonly provider: CaptchaSolverProvider;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly logger?: FastifyBaseLogger;

  constructor(config: CaptchaSolverConfig, logger?: FastifyBaseLogger) {
    this.enabled = config.enabled;
    this.mode = config.mode ?? "auto";
    this.allowedOrigins = normalizeAllowedOrigins(config.allowedOrigins);
    this.allowAnyOrigin = config.allowAnyOrigin ?? false;
    this.timeoutMs = config.timeoutMs;
    this.pollIntervalMs = config.pollIntervalMs;
    this.logger = logger;

    // Construct eagerly so a missing API key fails fast at startup rather than
    // at first request — unless disabled, in which case no key is required.
    if (this.enabled) {
      this.provider = this.buildProvider(config);
    } else {
      // A throwaway placeholder; never used when disabled.
      this.provider = {} as CaptchaSolverProvider;
    }

    if (this.enabled && this.allowAnyOrigin) {
      // Surfaced once at construction so a misconfigured wildcard is visible in
      // startup logs, not buried in per-request output.
      this.logger?.warn(
        "[CaptchaSolver] wildcard origin mode active — origin allowlist bypassed",
      );
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getMode(): CaptchaSolverMode {
    return this.mode;
  }

  /**
   * Whether `/solve` may proceed. False when the master flag is off OR the mode
   * is `detect-only`. `/detect` is unaffected and works in every enabled mode.
   */
  canSolve(): boolean {
    return this.enabled && this.mode !== "detect-only" && this.mode !== "off";
  }

  /** How this request's origin was (or would be) authorized. */
  originModeFor(url: string): OriginMode {
    return this.allowAnyOrigin ? "wildcard" : "allowlist";
  }

  /** True if the gate would open for this URL. Does not solve. */
  isAllowed(url: string): boolean {
    if (!this.enabled) return false;
    if (this.allowAnyOrigin) return true;
    return this.allowedOrigins.includes(parseOrigin(url));
  }

  async solve(
    widget: CaptchaWidgetDescriptor,
  ): Promise<SolveOutcome> {
    const gate = this.requireEnabledAllowed(widget.url);
    if (gate) return gate;

    if (!this.canSolve()) {
      return {
        status: "detect_only",
        mode: this.mode,
        originMode: this.originModeFor(widget.url),
        allowedOrigin: this.allowAnyOrigin ? undefined : parseOrigin(widget.url),
        redacted: { url: redactUrl(widget.url) },
        error:
          "Captcha solver is in detect-only mode; /solve is blocked. Set CAPTCHA_SOLVER_MODE=auto to enable solving.",
      };
    }

    try {
      const result: SolveResult = await this.provider.solve(
        { widget },
        { timeoutMs: this.timeoutMs, pollIntervalMs: this.pollIntervalMs },
      );

      if (this.allowAnyOrigin) {
        this.logger?.warn(
          { provider: this.provider.type, type: widget.type },
          "[CaptchaSolver] solved under wildcard origin mode",
        );
      }

      return {
        status: "solved",
        token: result.token,
        text: result.text,
        coordinates: result.coordinates,
        angle: result.angle,
        providerTaskId: result.providerTaskId,
        provider: this.provider.type,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        mode: this.mode,
        originMode: this.originModeFor(widget.url),
        allowedOrigin: this.allowAnyOrigin ? undefined : parseOrigin(widget.url),
        redacted: { url: redactUrl(widget.url) },
      };
    } catch (error) {
      return this.toErrorOutcome(error, widget.url);
    }
  }

  private requireEnabledAllowed(url: string): SolveOutcome | undefined {
    if (!this.enabled) {
      return {
        status: "disabled",
        mode: this.mode,
        originMode: this.originModeFor(url),
        redacted: { url: redactUrl(url) },
        error:
          "Captcha solver is disabled. Set CAPTCHA_SOLVER_ENABLED=true and CAPTCHA_SOLVER_ALLOWED_ORIGINS to enable.",
      };
    }

    if (!this.allowAnyOrigin) {
      const origin = parseOrigin(url);
      if (!this.allowedOrigins.includes(origin)) {
        return {
          status: "origin_not_allowed",
          mode: this.mode,
          originMode: "allowlist",
          allowedOrigin: origin,
          redacted: { url: redactUrl(url) },
          error: "URL origin is not exactly allowlisted for captcha solving.",
        };
      }
    }
    return undefined;
  }

  private toErrorOutcome(error: unknown, url: string): SolveOutcome {
    const message = (error as Error).message ?? String(error);
    let code: string | undefined;
    if (error instanceof CaptchaSolverError) code = error.providerCode;
    this.logger?.warn(
      { err: message, code, provider: this.provider.type },
      `[CaptchaSolver] solve failed`,
    );
    return {
      status: error instanceof CaptchaUnsupportedWidgetError ? "solver_error" : "solver_error",
      provider: this.provider.type,
      mode: this.mode,
      originMode: this.originModeFor(url),
      allowedOrigin: this.allowAnyOrigin ? undefined : parseOrigin(url),
      redacted: { url: redactUrl(url) },
      error: message,
      errorCode: code,
    };
  }

  private buildProvider(config: CaptchaSolverConfig): CaptchaSolverProvider {
    const apiKey = config.apiKey;
    if (!apiKey) {
      throw new CaptchaSolverError(
        `Captcha solver is enabled but CAPTCHA_SOLVER_API_KEY is not set`,
        500,
        "missing_api_key",
      );
    }
    switch (config.provider) {
      case "2captcha":
        return new TwoCaptchaProvider(apiKey);
      case "capsolver":
        return new CapSolverProvider(apiKey);
      case "anti-captcha":
        return new AntiCaptchaProvider(apiKey);
      case "capmonster":
        return new CapMonsterProvider(apiKey);
    }
  }
}

// Re-exported so the route layer can branch image vs token without importing
// the provider types directly.
export { isImageType };

export const createCaptchaSolverService = (
  config: CaptchaSolverConfig,
  logger?: FastifyBaseLogger,
) => new CaptchaSolverService(config, logger);
