/**
 * 2Captcha (2captcha.com) adapter.
 *
 * 2Captcha exposes the same anti-captcha-style createTask / getTaskResult JSON
 * API (https://api.2captcha.com/createTask), so it reuses the base polling loop.
 *
 * 2Captcha has the broadest catalog of the supported providers. Tier 1+2 token
 * task types are declared here; the image/puzzle task types share names with
 * the anti-captcha family (`ImageToCoordinatesTask`, `RotateTask`, …).
 */
import { BaseSolverProvider } from "./base-solver-provider.js";
import type { CaptchaWidgetType } from "./captcha-provider.js";

export class TwoCaptchaProvider extends BaseSolverProvider {
  readonly type = "2captcha" as const;
  readonly supportedTypes: ReadonlyArray<CaptchaWidgetType> = [
    // Original token widgets.
    "recaptcha_v2",
    "recaptcha_v3",
    "hcaptcha",
    "turnstile",
    // Tier 1 token widgets.
    "geetest",
    "geetest_v4",
    "funcaptcha",
    "yandex_smartcaptcha",
    "amazon_waf",
    // Tier 2 token widgets.
    "tencent",
    "capy_puzzle",
    "cybersiara",
    "mtcaptcha",
    "friendly_captcha",
    "cutcaptcha",
    // Image / puzzle widgets.
    "image_text",
    "image_grid",
    "image_click",
    "image_rotate",
    "image_canvas",
    "image_audio",
  ];
  protected readonly endpoint = "https://api.2captcha.com";

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
      case "yandex_smartcaptcha":
        return "YandexSmartCaptchaTaskProxyless";
      case "amazon_waf":
        return "AmazonTaskProxyless";
      case "tencent":
        return "TencentTaskProxyless";
      case "capy_puzzle":
        return "CapyTaskProxyless";
      case "cybersiara":
        return "AntiCyberSiAraTaskProxyless";
      case "mtcaptcha":
        return "MTCaptchaTaskProxyless";
      case "friendly_captcha":
        return "FriendlyCaptchaTaskProxyless";
      case "cutcaptcha":
        return "CutCaptchaTaskProxyless";
      case "image_text":
        return "ImageToTextTask";
      case "image_grid":
        return "ImageToCoordinatesTask";
      case "image_click":
        return "ImageToCoordinatesTask";
      case "image_rotate":
        return "RotateTask";
      case "image_canvas":
        return "ImageToCoordinatesTask";
      case "image_audio":
        return "AudioTask";
      default:
        return undefined;
    }
  }
}
