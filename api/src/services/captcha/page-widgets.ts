/**
 * Live-page CAPTCHA widget detection and solved-token injection.
 *
 * The DOM logic is split into pure, framework-agnostic scanner/injector
 * functions (`scanWidgets` / `injectIntoDom`) that operate on a tiny
 * `WidgetDom` interface. These pure functions are unit-tested directly. The
 * `detectWidgets` / `injectToken` wrappers re-implement the same logic inside
 * `page.evaluate` closures (puppeteer serializes the evaluate callback, so it
 * cannot reference outer-scope helpers) — both implementations are kept in
 * sync via the page-widgets test, which exercises the pure path.
 */
import type { Page } from "puppeteer-core";
import type { CaptchaWidgetDescriptor, CaptchaWidgetType } from "./captcha-provider.js";

/** Minimal shape these helpers call on a Page — narrow for testability. */
type EvaluablePage = Pick<Page, "evaluate">;

interface RawWidget {
  type: CaptchaWidgetType;
  sitekey?: string;
  selector?: string;
  action?: string;
  // GeeTest v3 / v4.
  gt?: string;
  challenge?: string;
  captchaId?: string;
  // Arkose / FunCaptcha.
  publicKey?: string;
  serviceUrl?: string;
  blob?: string;
  // Generic per-provider task id.
  taskId?: string;
}

/** A narrow view of an Element sufficient for scanning/injecting. */
export interface WidgetDomElement {
  tagName: string;
  id: string;
  className: string;
  getAttribute(name: string): string | null;
}

/**
 * A narrow view of document sufficient for scanning/injecting. The optional
 * globals mirror the per-widget registries injected by their SDKs; they let
 * the scanner recover parameters that are not rendered as data attributes.
 */
export interface WidgetDom {
  querySelectorAll(selector: string): WidgetDomElement[];
  querySelector(selector: string): WidgetDomElement | null;
  grecaptchaClients?: Record<string, { sitekey?: string; callback?: (token: string) => void }>;
  hcaptcha?: { execute?: () => void };
  // Arkose / FunCaptcha enforcement global.
  arkoseEnforcement?: { setConfig?: (config: unknown) => void };
  // GeeTest product registry (window.geetest_data / initGeetest payloads).
  geetestData?: Record<string, string>;
}

const selectorFor = (el: WidgetDomElement): string => {
  if (el.id) return `#${el.id}`;
  const tag = el.tagName.toLowerCase();
  const cls =
    typeof el.className === "string"
      ? el.className
          .split(/\s+/)
          .filter(Boolean)
          .map((c) => `.${c}`)
          .join("")
      : "";
  return cls ? `${tag}${cls}` : tag;
};

/**
 * The canonical identifier for a widget — the field the provider needs to solve
 * it. Different families key on different values (sitekey vs gt vs public key),
 * so the dedup/validity check is per-type.
 */
const widgetKey = (widget: RawWidget): string | undefined => {
  switch (widget.type) {
    case "geetest":
      return widget.gt;
    case "geetest_v4":
      return widget.captchaId;
    case "funcaptcha":
      return widget.publicKey;
    default:
      return widget.sitekey ?? widget.taskId;
  }
};

/**
 * Scans a DOM-like object for known CAPTCHA widgets. Pure and testable. Order
 * is stable: reCAPTCHA (v2/v3), then hCaptcha, then Turnstile, then the Tier
 * 1+2 token widgets, then image/puzzle containers (detected separately by the
 * image pipeline, not here).
 */
export function scanWidgets(dom: WidgetDom): RawWidget[] {
  const out: RawWidget[] = [];
  const seen = new Set<string>();

  const attr = (el: WidgetDomElement | null, name: string) =>
    el?.getAttribute(name) ?? undefined;

  const add = (widget: RawWidget) => {
    const key = `${widget.type}:${widgetKey(widget)}:${widget.selector ?? ""}`;
    if (widgetKey(widget) && !seen.has(key)) {
      seen.add(key);
      out.push(widget);
    }
  };

  // reCAPTCHA v2 / v3. Only treat an element as reCAPTCHA if it carries the
  // .g-recaptcha class — hCaptcha and Turnstile widgets also expose
  // data-sitekey, so matching on the attribute alone misclassifies them.
  for (const el of dom.querySelectorAll(".g-recaptcha")) {
    const sitekey = attr(el, "data-sitekey");
    if (!sitekey) continue;
    const size = attr(el, "data-size");
    const action = attr(el, "data-action");
    // data-size="invisible" or an explicit action signals v3.
    const isV3 = size === "invisible" || !!action;
    add({
      type: isV3 ? "recaptcha_v3" : "recaptcha_v2",
      sitekey,
      selector: selectorFor(el),
      action: action || undefined,
    });
  }

  // Fallback: reCAPTCHA rendered via grecaptcha.render() with no data-sitekey.
  if (dom.grecaptchaClients) {
    for (const client of Object.values(dom.grecaptchaClients)) {
      if (client?.sitekey) add({ type: "recaptcha_v2", sitekey: client.sitekey });
    }
  }

  for (const el of dom.querySelectorAll(".h-captcha")) {
    const sitekey = attr(el, "data-sitekey");
    if (!sitekey) continue;
    add({ type: "hcaptcha", sitekey, selector: selectorFor(el) });
  }

  for (const el of dom.querySelectorAll(".cf-turnstile")) {
    const sitekey = attr(el, "data-sitekey");
    if (!sitekey) continue;
    add({ type: "turnstile", sitekey, selector: selectorFor(el) });
  }

  // --- Tier 1 token widgets ---

  // GeeTest v3: the SDK renders into .geetest_widget and exposes gt/challenge
  // via the geetest_data global. The data attributes are best-effort.
  for (const el of dom.querySelectorAll(".geetest_widget, .geetest_holder, #geetest-captcha")) {
    const gt = attr(el, "data-gt") ?? dom.geetestData?.gt;
    const challenge = attr(el, "data-challenge") ?? dom.geetestData?.challenge;
    if (gt) add({ type: "geetest", gt, challenge, selector: selectorFor(el) });
  }
  // GeeTest v4: keyed on captcha_id.
  for (const el of dom.querySelectorAll(".geetest_widget, .geetest_holder, #geetest-captcha")) {
    const captchaId = attr(el, "data-captcha-id") ?? dom.geetestData?.captcha_id;
    if (captchaId) add({ type: "geetest_v4", captchaId, selector: selectorFor(el) });
  }

  // Arkose / FunCaptcha: data-pkey on the container, or an fc-token input.
  for (const el of dom.querySelectorAll("[data-pkey], #funcaptcha, .funcaptcha")) {
    const publicKey = attr(el, "data-pkey");
    if (publicKey) add({ type: "funcaptcha", publicKey, selector: selectorFor(el) });
  }
  {
    const fcToken = dom.querySelector("[name='fc-token'], input[name='fc-token']");
    const publicKey = fcToken ? fcToken.getAttribute("value")?.split("|")[0] : undefined;
    if (publicKey) add({ type: "funcaptcha", publicKey, selector: "[name='fc-token']" });
  }

  // Yandex SmartCaptcha.
  for (const el of dom.querySelectorAll(".smart-captcha, #captcha-container, #smart-captcha")) {
    const sitekey = attr(el, "data-sitekey");
    if (sitekey) add({ type: "yandex_smartcaptcha", sitekey, selector: selectorFor(el) });
  }

  // Amazon WAF captcha.
  for (const el of dom.querySelectorAll("[data-aws-waf-captcha], #aws-waf-token, .aws-waf-captcha")) {
    const sitekey = attr(el, "data-sitekey") ?? attr(el, "data-aws-waf-captcha");
    if (sitekey) add({ type: "amazon_waf", sitekey, selector: selectorFor(el) });
  }

  // --- Tier 2 token widgets ---

  for (const el of dom.querySelectorAll("#tcaptcha, .tcaptcha-iframe, [data-tencent-captcha]")) {
    const sitekey = attr(el, "data-appid") ?? attr(el, "data-sitekey");
    if (sitekey) add({ type: "tencent", sitekey, taskId: attr(el, "data-appid") ?? undefined, selector: selectorFor(el) });
  }
  for (const el of dom.querySelectorAll(".capy-captcha, [data-capy-sitekey], #capy-captcha")) {
    const sitekey = attr(el, "data-capy-sitekey") ?? attr(el, "data-sitekey");
    if (sitekey) add({ type: "capy_puzzle", sitekey, selector: selectorFor(el) });
  }
  for (const el of dom.querySelectorAll("#cybersiara-box, .cybersiara, [data-cybersiara]")) {
    const sitekey = attr(el, "data-sitekey") ?? attr(el, "data-cybersiara");
    if (sitekey) add({ type: "cybersiara", sitekey, selector: selectorFor(el) });
  }
  for (const el of dom.querySelectorAll("#mtcaptcha, .mtcaptcha, [data-mtcaptcha-sitekey]")) {
    const sitekey = attr(el, "data-mtcaptcha-sitekey") ?? attr(el, "data-sitekey");
    if (sitekey) add({ type: "mtcaptcha", sitekey, selector: selectorFor(el) });
  }
  for (const el of dom.querySelectorAll(".friendly-captcha, #frc-captcha, [data-frc-sitekey]")) {
    const sitekey = attr(el, "data-sitekey") ?? attr(el, "data-frc-sitekey");
    if (sitekey) add({ type: "friendly_captcha", sitekey, selector: selectorFor(el) });
  }
  for (const el of dom.querySelectorAll("#puzzle-captcha, .cutcaptcha, [data-cutcaptcha], [data-puzzleid]")) {
    const sitekey = attr(el, "data-puzzleid") ?? attr(el, "data-sitekey");
    if (sitekey) add({ type: "cutcaptcha", sitekey, selector: selectorFor(el) });
  }

  return out;
}

/** Outcome of an injection attempt. */
export interface InjectionResult {
  written: boolean;
  callbackFired: boolean;
}

/** Writes the token and fires the widget callback. Pure and testable. */
export function injectIntoDom(
  dom: WidgetDom,
  type: CaptchaWidgetType,
  token: string,
): InjectionResult {
  let written = false;
  let callbackFired = false;

  const setField = (selector: string): boolean => {
    if (dom.querySelector(selector)) {
      written = true;
      return true;
    }
    return false;
  };

  switch (type) {
    case "recaptcha_v2":
    case "recaptcha_v3": {
      written = setField("#g-recaptcha-response") || setField("[name='g-recaptcha-response']");
      if (dom.grecaptchaClients) {
        for (const client of Object.values(dom.grecaptchaClients)) {
          if (typeof client?.callback === "function") {
            client.callback(token);
            callbackFired = true;
          }
        }
      }
      break;
    }
    case "hcaptcha": {
      written = setField("[name='h-captcha-response']");
      if (typeof dom.hcaptcha?.execute === "function") {
        dom.hcaptcha.execute();
        callbackFired = true;
      }
      break;
    }
    case "turnstile": {
      written = setField("[name='cf-turnstile-response']");
      break;
    }
    case "geetest":
    case "geetest_v4": {
      // GeeTest expects three hidden fields; the token is a composite but the
      // provider returns a single validate string we write to all three.
      written =
        setField("[name='geetest_validate']") ||
        setField("[name='geetest_seccode']") ||
        setField("[name='geetest_challenge']");
      break;
    }
    case "funcaptcha": {
      written = setField("[name='fc-token']") || setField("input[name='fc-token']");
      if (dom.arkoseEnforcement && typeof dom.arkoseEnforcement.setConfig === "function") {
        dom.arkoseEnforcement.setConfig({ onCompleted: { token } });
        callbackFired = true;
      }
      break;
    }
    case "yandex_smartcaptcha": {
      written = setField("[name='smart-captcha-submit']") || setField("input[name='smart-token']");
      break;
    }
    case "amazon_waf": {
      written = setField("input[name='captcha-verifier']") || setField("#aws-waf-token");
      break;
    }
    case "tencent": {
      written = setField("[name='TencentCaptcha']") || setField("input[name='ticket']");
      break;
    }
    case "capy_puzzle": {
      written = setField("[name='capy-captcha-response']") || setField("input[name='capy_respkey']");
      break;
    }
    case "cybersiara": {
      written = setField("[name='cybersiara-response']");
      break;
    }
    case "mtcaptcha": {
      written = setField("[name='mtcaptcha-verifiedtoken']");
      break;
    }
    case "friendly_captcha": {
      // Friendly Captcha writes into the .frc-captcha-solution input.
      written = setField("[name='frc-captcha-solution']") || setField(".frc-captcha-solution");
      break;
    }
    case "cutcaptcha": {
      written = setField("[name='puzzle-captcha']") || setField("#puzzle-captcha");
      break;
    }
    // Image/puzzle widgets are injected via the dedicated image pipeline
    // (page-image.ts), not here.
    case "image_text":
    case "image_grid":
    case "image_click":
    case "image_rotate":
    case "image_canvas":
    case "image_audio":
      break;
  }

  return { written, callbackFired };
}

/**
 * Scans the live page for CAPTCHA widgets. The body is self-contained (no
 * outer-scope references) because puppeteer serializes the evaluate callback.
 */
export async function detectWidgets(
  page: EvaluablePage,
  url: string,
): Promise<CaptchaWidgetDescriptor[]> {
  const raw = await page.evaluate<RawWidget[]>(() => {
    const els = (sel: string) =>
      Array.from(document.querySelectorAll<HTMLElement>(sel)).map((el) => ({
        tagName: el.tagName,
        id: el.id,
        className: typeof el.className === "string" ? el.className : "",
        getAttribute: (n: string) => el.getAttribute(n),
      }));
    const geetestData = (window as unknown as { geetest_data?: Record<string, string> }).geetest_data;
    const dom = {
      querySelectorAll: els,
      querySelector: (sel: string) => els(sel)[0] ?? null,
      grecaptchaClients: (
        window as unknown as {
          ___grecaptcha_cfg?: { clients?: Record<string, { sitekey?: string }> };
        }
      ).___grecaptcha_cfg?.clients,
      geetestData,
    };

    const selectorFor = (el: { id: string; tagName: string; className: string }): string => {
      if (el.id) return `#${el.id}`;
      const tag = el.tagName.toLowerCase();
      const cls =
        typeof el.className === "string"
          ? el.className
              .split(/\s+/)
              .filter(Boolean)
              .map((c) => `.${CSS.escape(c)}`)
              .join("")
          : "";
      return cls ? `${tag}${cls}` : tag;
    };

    const widgetKey = (w: RawWidget): string | undefined => {
      switch (w.type) {
        case "geetest":
          return w.gt;
        case "geetest_v4":
          return w.captchaId;
        case "funcaptcha":
          return w.publicKey;
        default:
          return w.sitekey ?? w.taskId;
      }
    };

    const out: RawWidget[] = [];
    const seen = new Set<string>();
    const add = (w: RawWidget) => {
      const key = `${w.type}:${widgetKey(w)}:${w.selector ?? ""}`;
      if (widgetKey(w) && !seen.has(key)) {
        seen.add(key);
        out.push(w);
      }
    };
    const attr = (e: ReturnType<typeof els>[number] | undefined, n: string) =>
      e?.getAttribute(n) ?? undefined;

    for (const el of dom.querySelectorAll(".g-recaptcha")) {
      const sitekey = attr(el, "data-sitekey");
      if (!sitekey) continue;
      const size = attr(el, "data-size");
      const action = attr(el, "data-action");
      const isV3 = size === "invisible" || !!action;
      add({
        type: isV3 ? "recaptcha_v3" : "recaptcha_v2",
        sitekey,
        selector: selectorFor(el),
        action: action || undefined,
      });
    }
    if (dom.grecaptchaClients) {
      for (const client of Object.values(dom.grecaptchaClients)) {
        if (client?.sitekey) add({ type: "recaptcha_v2", sitekey: client.sitekey });
      }
    }
    for (const el of dom.querySelectorAll(".h-captcha")) {
      const sitekey = attr(el, "data-sitekey");
      if (!sitekey) continue;
      add({ type: "hcaptcha", sitekey, selector: selectorFor(el) });
    }
    for (const el of dom.querySelectorAll(".cf-turnstile")) {
      const sitekey = attr(el, "data-sitekey");
      if (!sitekey) continue;
      add({ type: "turnstile", sitekey, selector: selectorFor(el) });
    }

    // --- Tier 1 token widgets ---
    for (const el of dom.querySelectorAll(".geetest_widget, .geetest_holder, #geetest-captcha")) {
      const gt = attr(el, "data-gt") ?? geetestData?.gt;
      const challenge = attr(el, "data-challenge") ?? geetestData?.challenge;
      if (gt) add({ type: "geetest", gt, challenge, selector: selectorFor(el) });
    }
    for (const el of dom.querySelectorAll(".geetest_widget, .geetest_holder, #geetest-captcha")) {
      const captchaId = attr(el, "data-captcha-id") ?? geetestData?.captcha_id;
      if (captchaId) add({ type: "geetest_v4", captchaId, selector: selectorFor(el) });
    }
    for (const el of dom.querySelectorAll("[data-pkey], #funcaptcha, .funcaptcha")) {
      const publicKey = attr(el, "data-pkey");
      if (publicKey) add({ type: "funcaptcha", publicKey, selector: selectorFor(el) });
    }
    {
      const fcToken = dom.querySelector("[name='fc-token'], input[name='fc-token']");
      const publicKey = fcToken ? fcToken.getAttribute("value")?.split("|")[0] : undefined;
      if (publicKey) add({ type: "funcaptcha", publicKey, selector: "[name='fc-token']" });
    }
    for (const el of dom.querySelectorAll(".smart-captcha, #captcha-container, #smart-captcha")) {
      const sitekey = attr(el, "data-sitekey");
      if (sitekey) add({ type: "yandex_smartcaptcha", sitekey, selector: selectorFor(el) });
    }
    for (const el of dom.querySelectorAll("[data-aws-waf-captcha], #aws-waf-token, .aws-waf-captcha")) {
      const sitekey = attr(el, "data-sitekey") ?? attr(el, "data-aws-waf-captcha");
      if (sitekey) add({ type: "amazon_waf", sitekey, selector: selectorFor(el) });
    }

    // --- Tier 2 token widgets ---
    for (const el of dom.querySelectorAll("#tcaptcha, .tcaptcha-iframe, [data-tencent-captcha]")) {
      const sitekey = attr(el, "data-appid") ?? attr(el, "data-sitekey");
      if (sitekey) add({ type: "tencent", sitekey, taskId: attr(el, "data-appid") ?? undefined, selector: selectorFor(el) });
    }
    for (const el of dom.querySelectorAll(".capy-captcha, [data-capy-sitekey], #capy-captcha")) {
      const sitekey = attr(el, "data-capy-sitekey") ?? attr(el, "data-sitekey");
      if (sitekey) add({ type: "capy_puzzle", sitekey, selector: selectorFor(el) });
    }
    for (const el of dom.querySelectorAll("#cybersiara-box, .cybersiara, [data-cybersiara]")) {
      const sitekey = attr(el, "data-sitekey") ?? attr(el, "data-cybersiara");
      if (sitekey) add({ type: "cybersiara", sitekey, selector: selectorFor(el) });
    }
    for (const el of dom.querySelectorAll("#mtcaptcha, .mtcaptcha, [data-mtcaptcha-sitekey]")) {
      const sitekey = attr(el, "data-mtcaptcha-sitekey") ?? attr(el, "data-sitekey");
      if (sitekey) add({ type: "mtcaptcha", sitekey, selector: selectorFor(el) });
    }
    for (const el of dom.querySelectorAll(".friendly-captcha, #frc-captcha, [data-frc-sitekey]")) {
      const sitekey = attr(el, "data-sitekey") ?? attr(el, "data-frc-sitekey");
      if (sitekey) add({ type: "friendly_captcha", sitekey, selector: selectorFor(el) });
    }
    for (const el of dom.querySelectorAll("#puzzle-captcha, .cutcaptcha, [data-cutcaptcha], [data-puzzleid]")) {
      const sitekey = attr(el, "data-puzzleid") ?? attr(el, "data-sitekey");
      if (sitekey) add({ type: "cutcaptcha", sitekey, selector: selectorFor(el) });
    }
    return out;
  });

  return (raw as RawWidget[]).map((widget) => ({ ...widget, url }));
}

/** Injects a solved token into the page and fires the widget callback. */
export async function injectToken(
  page: EvaluablePage,
  widget: CaptchaWidgetDescriptor,
  token: string,
): Promise<boolean> {
  const result = await page.evaluate(
    (type: CaptchaWidgetType, tokenValue: string) => {
      const setField = (selector: string) => {
        const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
        if (!el) return false;
        el.value = tokenValue;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      };
      switch (type) {
        case "recaptcha_v2":
        case "recaptcha_v3": {
          let written = setField("#g-recaptcha-response") || setField("[name='g-recaptcha-response']");
          const clients = (
            window as unknown as {
              ___grecaptcha_cfg?: {
                clients?: Record<string, { callback?: (t: string) => void }>;
              };
            }
          ).___grecaptcha_cfg?.clients;
          if (clients) {
            for (const client of Object.values(clients)) {
              if (typeof client?.callback === "function") client.callback(tokenValue);
            }
          }
          return { written };
        }
        case "hcaptcha": {
          let written = setField("[name='h-captcha-response']");
          const hcaptcha = (window as unknown as { hcaptcha?: { execute?: () => void } }).hcaptcha;
          if (typeof hcaptcha?.execute === "function") hcaptcha.execute();
          return { written };
        }
        case "turnstile": {
          return { written: setField("[name='cf-turnstile-response']") };
        }
        case "geetest":
        case "geetest_v4": {
          return {
            written:
              setField("[name='geetest_validate']") ||
              setField("[name='geetest_seccode']") ||
              setField("[name='geetest_challenge']"),
          };
        }
        case "funcaptcha": {
          let written = setField("[name='fc-token']") || setField("input[name='fc-token']");
          const enforcement = (window as unknown as { ArkoseEnforcement?: { setConfig?: (c: unknown) => void } }).ArkoseEnforcement;
          if (typeof enforcement?.setConfig === "function") enforcement.setConfig({ onCompleted: { token: tokenValue } });
          return { written };
        }
        case "yandex_smartcaptcha": {
          return { written: setField("[name='smart-captcha-submit']") || setField("input[name='smart-token']") };
        }
        case "amazon_waf": {
          return { written: setField("input[name='captcha-verifier']") || setField("#aws-waf-token") };
        }
        case "tencent": {
          return { written: setField("[name='TencentCaptcha']") || setField("input[name='ticket']") };
        }
        case "capy_puzzle": {
          return { written: setField("[name='capy-captcha-response']") || setField("input[name='capy_respkey']") };
        }
        case "cybersiara": {
          return { written: setField("[name='cybersiara-response']") };
        }
        case "mtcaptcha": {
          return { written: setField("[name='mtcaptcha-verifiedtoken']") };
        }
        case "friendly_captcha": {
          return { written: setField("[name='frc-captcha-solution']") || setField(".frc-captcha-solution") };
        }
        case "cutcaptcha": {
          return { written: setField("[name='puzzle-captcha']") || setField("#puzzle-captcha") };
        }
        // Image widgets are applied by the dedicated image pipeline.
        case "image_text":
        case "image_grid":
        case "image_click":
        case "image_rotate":
        case "image_canvas":
        case "image_audio":
          return { written: false };
      }
    },
    widget.type,
    token,
  );
  return (result as { written?: boolean } | null)?.written ?? false;
}
