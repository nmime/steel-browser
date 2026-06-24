/**
 * Pluggable CAPTCHA solver provider interface.
 *
 * Mirrors the StorageProvider pattern: a typed discriminator, a request/result
 * shape, and a small typed error hierarchy. The gate (enabled flag + exact
 * origin allowlist, optionally a wildcard origin mode) lives in the consuming
 * service, not here — providers are transport-only and assume the caller has
 * already authorized the request.
 */

export type CaptchaSolverProviderType =
  | "2captcha"
  | "capsolver"
  | "anti-captcha"
  | "capmonster";

/**
 * All supported widget families.
 *
 * The union is split into three categories for routing:
 *   - token types: sitekey/parameter → provider → token → inject into page.
 *   - image types: live-page pixels/audio captured → provider → text/coords.
 *
 * `isImageType(type)` is the canonical classifier; keep it in sync with this
 * union whenever a new image type is added.
 */
export type CaptchaWidgetType =
  // Original token widgets.
  | "recaptcha_v2"
  | "recaptcha_v3"
  | "hcaptcha"
  | "turnstile"
  // Tier 1 token widgets.
  | "geetest"
  | "geetest_v4"
  | "funcaptcha"
  | "yandex_smartcaptcha"
  | "amazon_waf"
  // Tier 2 token widgets.
  | "tencent"
  | "capy_puzzle"
  | "cybersiara"
  | "mtcaptcha"
  | "friendly_captcha"
  | "cutcaptcha"
  // Image / puzzle widgets.
  | "image_text"
  | "image_grid"
  | "image_click"
  | "image_rotate"
  | "image_canvas"
  | "image_audio";

/** The image-type literals, kept as a const tuple for runtime classification. */
export const IMAGE_WIDGET_TYPES = [
  "image_text",
  "image_grid",
  "image_click",
  "image_rotate",
  "image_canvas",
  "image_audio",
] as const satisfies ReadonlyArray<CaptchaWidgetType>;

/** True when the widget type is solved via the image/puzzle pipeline. */
export const isImageType = (type: CaptchaWidgetType): boolean =>
  (IMAGE_WIDGET_TYPES as ReadonlyArray<string>).includes(type);

export interface CaptchaWidgetDescriptor {
  type: CaptchaWidgetType;
  /** The sitekey rendered on the widget (token widgets). */
  sitekey?: string;
  /** The page URL the widget was found on (page URL, not origin). */
  url: string;
  /** Best-effort CSS selector for the widget container, if discoverable. */
  selector?: string;
  /** reCAPTCHA v3 action, if applicable. */
  action?: string;

  // --- GeeTest v3 / v4 ---
  /** GeeTest v3 `gt` key. */
  gt?: string;
  /** GeeTest v3 `challenge` value. */
  challenge?: string;
  /** GeeTest v4 `captcha_id`. */
  captchaId?: string;

  // --- Arkose / FunCaptcha ---
  /** Arkose public key (`data-pkey` / `fc-token`). */
  publicKey?: string;
  /** Arkose service URL (surl). */
  serviceUrl?: string;
  /** Opaque provider blob (Arkose `data[blob]`, etc.). */
  blob?: string;

  // --- Generic per-provider task id (Yandex/Capy/CyberSiARA/MTCaptcha/etc.) ---
  /** Provider-specific task identifier, where distinct from `sitekey`. */
  taskId?: string;

  // --- Image / puzzle widgets ---
  /** Captured image (base64, no data: prefix) for image_* types. */
  imageBase64?: string;
  /** Captured grid tiles (base64 each), for `image_grid`. */
  imageGrid?: string[];
  /** Human-readable instructions accompanying the puzzle. */
  instructions?: string;
  /** Grid layout, when known. */
  rows?: number;
  cols?: number;
  /** Captured audio (base64), for `image_audio`. */
  audioBase64?: string;
  /** Audio language code (e.g. `en`, `ru`). */
  audioLang?: string;
}

export interface SolveRequest {
  widget: CaptchaWidgetDescriptor;
  /** Optional page user agent; some providers tune solving per UA. */
  userAgent?: string;
}

export interface SolveResult {
  /** The solved token to inject into the page's response field (token types). */
  token?: string;
  /** Recognized text (image_text / image_audio results). */
  text?: string;
  /** Click coordinates in page space (image_click / image_grid results). */
  coordinates?: Array<{ x: number; y: number }>;
  /** Rotation angle in degrees (image_rotate result). */
  angle?: number;
  /** Provider-side task id, useful for support tickets / debugging. */
  providerTaskId: string;
  /** Reported cost in USD, when the provider returns it. */
  costUsd?: number;
  /** Approximate wall-clock ms spent solving. */
  durationMs: number;
}

export interface SolveOptions {
  /** Hard ceiling for total solve time including polling. */
  timeoutMs: number;
  /** Delay between getTaskResult polls. */
  pollIntervalMs: number;
  /** Injected for testing; defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface CaptchaSolverProvider {
  readonly type: CaptchaSolverProviderType;
  readonly supportedTypes: ReadonlyArray<CaptchaWidgetType>;
  solve(request: SolveRequest, options?: SolveOptions): Promise<SolveResult>;
}

/**
 * Solver operating mode. `detect-only` lets `/detect` run but blocks `/solve`,
 * so an operator can inspect pages without ever spending money or calling a
 * provider. `auto` is the historical behaviour.
 */
export type CaptchaSolverMode = "off" | "detect-only" | "auto";

export class CaptchaSolverError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 502,
    public readonly providerCode?: string,
  ) {
    super(message);
    this.name = "CaptchaSolverError";
  }
}

export class CaptchaUnsupportedWidgetError extends CaptchaSolverError {
  constructor(provider: CaptchaSolverProviderType, type: CaptchaWidgetType) {
    super(
      `Provider "${provider}" does not support ${type} widgets`,
      422,
      "unsupported_widget",
    );
    this.name = "CaptchaUnsupportedWidgetError";
  }
}

export class CaptchaSolverTimeoutError extends CaptchaSolverError {
  constructor(providerTaskId: string, timeoutMs: number) {
    super(
      `Solver timed out after ${timeoutMs}ms (task ${providerTaskId})`,
      504,
      "timeout",
    );
    this.name = "CaptchaSolverTimeoutError";
  }
}

export class CaptchaSolverRejectedError extends CaptchaSolverError {
  constructor(message: string, providerCode?: string) {
    super(message, 502, providerCode);
    this.name = "CaptchaSolverRejectedError";
  }
}
