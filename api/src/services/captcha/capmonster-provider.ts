/**
 * CapMonster Cloud (capmonster.cloud) adapter.
 *
 * CapMonster Cloud mirrors Anti-Captcha's JSON API and task-type naming
 * verbatim, differing only in endpoint. Implemented as a direct sibling of
 * AntiCaptchaProvider (both extend BaseSolverProvider) so each provider keeps
 * its own literal `type`.
 */
import { BaseSolverProvider } from "./base-solver-provider.js";
import type { CaptchaWidgetType } from "./captcha-provider.js";

export class CapMonsterProvider extends BaseSolverProvider {
  readonly type = "capmonster" as const;
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
  protected readonly endpoint = "https://api.capmonster.cloud";

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
