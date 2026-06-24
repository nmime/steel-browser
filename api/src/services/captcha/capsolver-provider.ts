/**
 * CapSolver (capsolver.com) adapter.
 *
 * CapSolver uses the same createTask / getTaskResult flow but with its own
 * task-type naming (`ReCaptcha...` with a capital C, `AntiTurnstile...`, and a
 * `ProxyLess` with a capital L). CapSolver reports v3 tokens via a
 * `gRecaptchaResponse` solution field, which the base extractToken handles.
 *
 * CapSolver supports a strong token catalog but for image/puzzle widgets only
 * exposes `ImageToTextTask` reliably; the coordinate/rotate/canvas/audio task
 * types return `undefined` here and surface as `unsupported_widget`. This is
 * intentional — the matrix reflects each provider's actual capability.
 */
import { BaseSolverProvider } from "./base-solver-provider.js";
import type { CaptchaWidgetType } from "./captcha-provider.js";

export class CapSolverProvider extends BaseSolverProvider {
  readonly type = "capsolver" as const;
  readonly supportedTypes: ReadonlyArray<CaptchaWidgetType> = [
    "recaptcha_v2",
    "recaptcha_v3",
    "hcaptcha",
    "turnstile",
    "geetest",
    "geetest_v4",
    "funcaptcha",
    "image_text",
  ];
  protected readonly endpoint = "https://api.capsolver.com";

  protected taskTypeFor(type: CaptchaWidgetType): string | undefined {
    switch (type) {
      case "recaptcha_v2":
        return "ReCaptchaV2TaskProxyLess";
      case "recaptcha_v3":
        return "ReCaptchaV3TaskProxyLess";
      case "hcaptcha":
        return "HCaptchaTaskProxyLess";
      case "turnstile":
        return "AntiTurnstileTaskProxyLess";
      case "geetest":
        return "GeeTestTaskProxyLess";
      case "geetest_v4":
        return "GeeTestV4TaskProxyLess";
      case "funcaptcha":
        return "FunCaptchaTaskProxyLess";
      case "image_text":
        return "ImageToTextTask";
      default:
        return undefined;
    }
  }
}
