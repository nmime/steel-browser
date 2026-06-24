/**
 * Anti-Captcha (anti-captcha.com) adapter.
 *
 * Anti-Captcha is the canonical anti-captcha-style JSON API; it is also the
 * closest shape to what CapMonster Cloud exposes, so the CapMonster adapter
 * mirrors these task-type strings.
 *
 * Anti-Captcha supports the core token families plus GeeTest and FunCaptcha but
 * lags 2Captcha on some Tier-2 additions; `taskTypeFor` returns `undefined` for
 * anything it does not support, which the base loop surfaces as a typed
 * `unsupported_widget` error.
 */
import { BaseSolverProvider } from "./base-solver-provider.js";
import type { CaptchaWidgetType } from "./captcha-provider.js";

export class AntiCaptchaProvider extends BaseSolverProvider {
  readonly type = "anti-captcha" as const;
  readonly supportedTypes: ReadonlyArray<CaptchaWidgetType> = [
    "recaptcha_v2",
    "recaptcha_v3",
    "hcaptcha",
    "turnstile",
    "geetest",
    "geetest_v4",
    "funcaptcha",
    "image_text",
    "image_grid",
    "image_click",
    "image_rotate",
    "image_canvas",
    "image_audio",
  ];
  protected readonly endpoint = "https://api.anti-captcha.com";

  protected taskTypeFor(type: CaptchaWidgetType): string | undefined {
    switch (type) {
      case "recaptcha_v2":
        return "RecaptchaV2TaskProxyless";
      case "recaptcha_v3":
        return "RecaptchaV3TaskProxyless";
      case "hcaptcha":
        return "HCaptchaTaskProxyless";
      case "turnstile":
        return "TurnstileTaskProxyless";
      case "geetest":
        return "GeeTestTaskProxyless";
      case "geetest_v4":
        return "GeeTestV4TaskProxyless";
      case "funcaptcha":
        return "FunCaptchaTaskProxyless";
      case "image_text":
        return "ImageToTextTask";
      case "image_grid":
      case "image_click":
      case "image_canvas":
        return "ImageToCoordinatesTask";
      case "image_rotate":
        return "RotateTask";
      case "image_audio":
        return "AudioTask";
      default:
        return undefined;
    }
  }
}
