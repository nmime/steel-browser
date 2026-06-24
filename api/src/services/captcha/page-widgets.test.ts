import { describe, expect, it, vi } from "vitest";
import {
  injectIntoDom,
  scanWidgets,
  type WidgetDom,
  type WidgetDomElement,
} from "./page-widgets.js";

const makeEl = (overrides: Partial<WidgetDomElement> & { attrs?: Record<string, string> }): WidgetDomElement => ({
  tagName: overrides.tagName ?? "DIV",
  id: overrides.id ?? "",
  className: overrides.className ?? "",
  getAttribute: (name: string) => overrides.attrs?.[name] ?? null,
});

/** A toy DOM backed by an explicit element list with a mini selector matcher. */
const makeDom = (
  elements: WidgetDomElement[],
  extras: Partial<WidgetDom> = {},
): WidgetDom => {
  const classesOf = (el: WidgetDomElement) =>
    typeof el.className === "string" ? el.className.split(/\s+/).filter(Boolean) : [];
  // Matches one simple selector: `.class`, `#id`, `[attr]`, a bare tag, or a
  // combination like `textarea[name='h-captcha-response']`.
  const matchesSimple = (sel: string, el: WidgetDomElement): boolean => {
    const classMatches = [...sel.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
    const idMatch = sel.match(/#([A-Za-z0-9_-]+)/);
    const attrMatches = [...sel.matchAll(/\[([A-Za-z-]+)(?:=['"]([^'"]*)['"])?\]/g)];
    const tagMatch = sel.match(/^[a-zA-Z]+/);
    if (tagMatch && el.tagName.toLowerCase() !== tagMatch[0].toLowerCase()) return false;
    if (idMatch && el.id !== idMatch[1]) return false;
    for (const cls of classMatches) {
      if (!classesOf(el).includes(cls)) return false;
    }
    for (const [, name, value] of attrMatches) {
      const attr = el.getAttribute(name);
      if (attr === null) return false;
      if (value !== undefined && attr !== value) return false;
    }
    return true;
  };
  const matches = (selector: string, el: WidgetDomElement) =>
    selector
      .split(",")
      .map((s) => s.trim())
      .some((s) => matchesSimple(s, el));
  return {
    querySelectorAll: (sel) => elements.filter((el) => matches(sel, el)),
    querySelector: (sel) => elements.find((el) => matches(sel, el)) ?? null,
    ...extras,
  };
};

describe("scanWidgets", () => {
  it("detects a reCAPTCHA v2 widget and reads its sitekey + selector", () => {
    const dom = makeDom([
      makeEl({ tagName: "DIV", id: "recaptcha", className: "g-recaptcha", attrs: { "data-sitekey": "6Lc_a" } }),
    ]);
    const [widget] = scanWidgets(dom);
    expect(widget).toEqual({
      type: "recaptcha_v2",
      sitekey: "6Lc_a",
      selector: "#recaptcha",
      action: undefined,
    });
  });

  it("classifies invisible / action-bearing reCAPTCHA as v3", () => {
    const dom = makeDom([
      makeEl({
        tagName: "DIV",
        className: "g-recaptcha",
        attrs: { "data-sitekey": "6Lc_b", "data-size": "invisible", "data-action": "login" },
      }),
    ]);
    expect(scanWidgets(dom)[0].type).toBe("recaptcha_v3");
    expect(scanWidgets(dom)[0].action).toBe("login");
  });

  it("detects hCaptcha and Turnstile widgets", () => {
    const dom = makeDom([
      makeEl({ tagName: "DIV", className: "h-captcha", attrs: { "data-sitekey": "hc-1" } }),
      makeEl({ tagName: "DIV", className: "cf-turnstile", attrs: { "data-sitekey": "cf-1" } }),
    ]);
    const widgets = scanWidgets(dom);
    expect(widgets).toEqual([
      expect.objectContaining({ type: "hcaptcha", sitekey: "hc-1" }),
      expect.objectContaining({ type: "turnstile", sitekey: "cf-1" }),
    ]);
  });

  it("falls back to the grecaptcha client registry when there is no container", () => {
    const dom: WidgetDom = {
      querySelectorAll: () => [],
      querySelector: () => null,
      grecaptchaClients: { "0": { sitekey: "client-only-key" } },
    };
    expect(scanWidgets(dom)).toEqual([
      expect.objectContaining({ type: "recaptcha_v2", sitekey: "client-only-key" }),
    ]);
  });

  it("returns an empty list when nothing matches", () => {
    const dom = makeDom([makeEl({ tagName: "DIV", className: "unrelated" })]);
    expect(scanWidgets(dom)).toEqual([]);
  });

  it("dedupes a widget that matches both .g-recaptcha and [data-sitekey]", () => {
    const dom = makeDom([
      makeEl({ tagName: "DIV", id: "r", className: "g-recaptcha", attrs: { "data-sitekey": "dup" } }),
    ]);
    expect(scanWidgets(dom).length).toBe(1);
  });

  it("detects GeeTest v3 via data-gt + data-challenge", () => {
    const dom = makeDom([
      makeEl({ tagName: "DIV", id: "geetest", className: "geetest_widget", attrs: { "data-gt": "gt-key-123", "data-challenge": "ch-456" } }),
    ]);
    const [widget] = scanWidgets(dom);
    expect(widget).toEqual(expect.objectContaining({ type: "geetest", gt: "gt-key-123", challenge: "ch-456" }));
  });

  it("detects GeeTest v4 via data-captcha-id", () => {
    const dom = makeDom([
      makeEl({ tagName: "DIV", id: "geetest4", className: "geetest_widget", attrs: { "data-captcha-id": "e392e1d7" } }),
    ]);
    const [widget] = scanWidgets(dom);
    expect(widget).toEqual(expect.objectContaining({ type: "geetest_v4", captchaId: "e392e1d7" }));
  });

  it("detects Arkose / FunCaptcha via data-pkey", () => {
    const dom = makeDom([
      makeEl({ tagName: "DIV", id: "arkose", className: "funcaptcha", attrs: { "data-pkey": "A2A14B1D-1AFD-..." } }),
    ]);
    const [widget] = scanWidgets(dom);
    expect(widget).toEqual(expect.objectContaining({ type: "funcaptcha", publicKey: "A2A14B1D-1AFD-..." }));
  });

  it("detects Yandex SmartCaptcha", () => {
    const dom = makeDom([
      makeEl({ tagName: "DIV", className: "smart-captcha", attrs: { "data-sitekey": "ysc1_xxx" } }),
    ]);
    expect(scanWidgets(dom)[0]).toEqual(expect.objectContaining({ type: "yandex_smartcaptcha", sitekey: "ysc1_xxx" }));
  });

  it("detects Friendly Captcha", () => {
    const dom = makeDom([
      makeEl({ tagName: "DIV", id: "frc", className: "friendly-captcha", attrs: { "data-sitekey": "FCABCDEF" } }),
    ]);
    expect(scanWidgets(dom)[0]).toEqual(expect.objectContaining({ type: "friendly_captcha", sitekey: "FCABCDEF" }));
  });

  it("detects multiple different widget types on the same page", () => {
    const dom = makeDom([
      makeEl({ tagName: "DIV", className: "g-recaptcha", attrs: { "data-sitekey": "rc-1" } }),
      makeEl({ tagName: "DIV", className: "cf-turnstile", attrs: { "data-sitekey": "ts-1" } }),
      makeEl({ tagName: "DIV", className: "funcaptcha", attrs: { "data-pkey": "pk-1" } }),
    ]);
    const types = scanWidgets(dom).map((w) => w.type);
    expect(types).toEqual(["recaptcha_v2", "turnstile", "funcaptcha"]);
  });
});

describe("injectIntoDom", () => {
  it("writes the token and fires the reCAPTCHA callback", () => {
    const callback = vi.fn();
    const dom = makeDom(
      [makeEl({ tagName: "TEXTAREA", id: "g-recaptcha-response" })],
      { grecaptchaClients: { "0": { callback } } },
    );
    const result = injectIntoDom(dom, "recaptcha_v2", "TOKEN");
    expect(result.written).toBe(true);
    expect(result.callbackFired).toBe(true);
    expect(callback).toHaveBeenCalledWith("TOKEN");
  });

  it("fires hcaptcha.execute and writes the response field", () => {
    const execute = vi.fn();
    const dom = makeDom([makeEl({ tagName: "TEXTAREA", attrs: {} })], { hcaptcha: { execute } });
    // h-captcha-response field absent by default
    let result = injectIntoDom(dom, "hcaptcha", "TOKEN");
    expect(result.written).toBe(false);
    expect(result.callbackFired).toBe(true);
    expect(execute).toHaveBeenCalled();

    // Now provide the field via a fake selector match
    const domWithField: WidgetDom = {
      querySelectorAll: () => [],
      querySelector: (sel) =>
        sel === "[name='h-captcha-response']" ? makeEl({ tagName: "TEXTAREA" }) : null,
      hcaptcha: { execute },
    };
    result = injectIntoDom(domWithField, "hcaptcha", "TOKEN");
    expect(result.written).toBe(true);
  });

  it("writes the Turnstile response field", () => {
    const dom: WidgetDom = {
      querySelectorAll: () => [],
      querySelector: (sel) =>
        sel === "[name='cf-turnstile-response']" ? makeEl({ tagName: "INPUT" }) : null,
    };
    expect(injectIntoDom(dom, "turnstile", "TOKEN").written).toBe(true);
  });

  it("reports written=false when the response field is missing", () => {
    const dom: WidgetDom = { querySelectorAll: () => [], querySelector: () => null };
    expect(injectIntoDom(dom, "recaptcha_v2", "TOKEN").written).toBe(false);
  });

  it("writes GeeTest hidden fields", () => {
    const dom = makeDom([makeEl({ tagName: "INPUT", attrs: { name: "geetest_validate" } })]);
    expect(injectIntoDom(dom, "geetest", "TOKEN").written).toBe(true);
  });

  it("writes the fc-token field and fires ArkoseEnforcement.setConfig", () => {
    const setConfig = vi.fn();
    const dom = makeDom([makeEl({ tagName: "INPUT", attrs: { name: "fc-token" } })], {
      arkoseEnforcement: { setConfig },
    });
    const result = injectIntoDom(dom, "funcaptcha", "TOKEN");
    expect(result.written).toBe(true);
    expect(result.callbackFired).toBe(true);
    expect(setConfig).toHaveBeenCalled();
  });

  it("writes the friendly-captcha solution field", () => {
    const dom = makeDom([makeEl({ tagName: "INPUT", attrs: { name: "frc-captcha-solution" } })]);
    expect(injectIntoDom(dom, "friendly_captcha", "TOKEN").written).toBe(true);
  });

  it("image widget types are no-ops in injectIntoDom", () => {
    const dom = makeDom([]);
    expect(injectIntoDom(dom, "image_text", "TOKEN")).toEqual({ written: false, callbackFired: false });
    expect(injectIntoDom(dom, "image_rotate", "TOKEN")).toEqual({ written: false, callbackFired: false });
  });
});
