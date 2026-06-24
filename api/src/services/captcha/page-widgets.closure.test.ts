/**
 * Closure-drift equivalence test.
 *
 * detectWidgets and injectToken each embed a self-contained closure inside
 * `page.evaluate(...)`. These closures DUPLICATE the logic of the pure
 * scanWidgets / injectIntoDom functions — they must, because puppeteer
 * serializes the evaluate callback and it cannot reference outer-scope helpers.
 *
 * The file header contract promises the two copies are kept in sync. This test
 * enforces that contract: it intercepts the closure passed to `page.evaluate`,
 * re-parses its source inside a jsdom realm (mirroring how puppeteer serializes
 * + executes it in the browser), and asserts it produces identical output to
 * the pure functions. If someone edits one copy without the other, this test
 * fails — catching the drift before it reaches production.
 *
 * This is the test that validates the code that ACTUALLY runs against a live
 * Chrome page, using real DOM APIs (querySelectorAll, getBoundingClientRect,
 * getAttribute, Event, CSS.escape).
 */
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { detectWidgets, injectToken, scanWidgets } from "./page-widgets.js";
import type { CaptchaWidgetType } from "./captcha-provider.js";

/**
 * Builds a jsdom document from HTML, optionally seeding window globals
 * (geetest_data, ___grecaptcha_cfg, etc.) that the closures read. Polyfills
 * CSS.escape (used by selectorFor in the closures) since jsdom doesn't expose
 * it by default.
 */
const buildDom = (
  html: string,
  windowSetup?: (window: Window & typeof globalThis) => void,
) => {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`, {
    runScripts: "outside-only",
    url: "https://test.example.com/page",
  });
  // jsdom lacks CSS.escape — polyfill it so the closure's selectorFor works.
  if (!(dom.window as unknown as { CSS?: { escape?: unknown } }).CSS) {
    (dom.window as unknown as { CSS: { escape: (s: string) => string } }).CSS = {
      escape: (s: string) => s.replace(/["'\\]/g, "\\$&"),
    };
  }
  if (windowSetup) windowSetup(dom.window);
  return dom;
};

/**
 * Runs a function inside the jsdom realm by serializing it via toString() and
 * re-parsing with window.eval(). This mirrors puppeteer's serialization: the
 * closure loses its Node-realm closures and resolves `document`, `window`,
 * `Event`, `CSS`, etc. against the jsdom globals.
 */
const runInRealm = <T>(
  dom: JSDOM,
  fn: (...args: never[]) => T,
  ...args: never[]
): T => {
  // Serialize the function source, eval it inside jsdom's realm, then invoke.
  const serialized = `(${fn.toString()})`;
  const realmFn = dom.window.eval(serialized) as (...a: never[]) => T;
  return realmFn(...args);
};

/**
 * Captures the closure that detectWidgets passes to page.evaluate, then runs it
 * inside jsdom. Returns the closure's raw result.
 */
const runDetectClosure = (
  html: string,
  windowSetup?: (window: Window & typeof globalThis) => void,
) => {
  const dom = buildDom(html, windowSetup);
  let closureResult: unknown;

  const fakePage = {
    evaluate: vi.fn(async (fn: (...args: never[]) => unknown) => {
      // Run the captured closure inside the jsdom realm and return its result
      // so detectWidgets' .map() works.
      closureResult = runInRealm(dom, fn);
      return closureResult;
    }),
  };

  // Fire-and-forget; detectWidgets awaits the evaluate above.
  void detectWidgets(fakePage as never, "https://test.example.com/page");
  expect(closureResult, "detectWidgets closure must produce a result").toBeDefined();
  return closureResult as Array<Record<string, unknown>>;
};

/**
 * Captures the closure that injectToken passes to page.evaluate, runs it inside
 * jsdom with the given widget type + token, and returns its result.
 */
const runInjectClosure = (
  html: string,
  type: CaptchaWidgetType,
  token: string,
): { written?: boolean } => {
  const dom = buildDom(html);
  let closureResult: unknown;

  const fakePage = {
    evaluate: vi.fn(async (fn: (...args: never[]) => unknown, ...args: never[]) => {
      closureResult = runInRealm(dom, fn, ...args);
      return closureResult;
    }),
  };

  void injectToken(
    fakePage as never,
    { type, url: "https://test.example.com" },
    token,
  );
  return (closureResult as { written?: boolean }) ?? {};
};

/** Runs scanWidgets (pure) against the same DOM for comparison. */
const runPureScan = (
  html: string,
  windowSetup?: (window: Window & typeof globalThis) => void,
) => {
  const dom = buildDom(html, windowSetup);
  const els = (sel: string) =>
    Array.from(dom.window.document.querySelectorAll(sel)).map((el) => {
      const node = el as HTMLElement;
      return {
        tagName: node.tagName,
        id: node.id,
        className: typeof node.className === "string" ? node.className : "",
        getAttribute: (n: string) => node.getAttribute(n),
      };
    });
  return scanWidgets({
    querySelectorAll: els,
    querySelector: (sel: string) => els(sel)[0] ?? null,
  });
};

/** Strips the url field (only on closure output) for fair comparison. */
const stripUrl = (widgets: Array<Record<string, unknown>>) =>
  widgets.map(({ url: _url, ...rest }) => {
    void _url;
    return rest;
  });

describe("detectWidgets closure ↔ scanWidgets equivalence", () => {
  const cases: Array<{ name: string; html: string; setup?: (w: Window & typeof globalThis) => void }> = [
    { name: "reCAPTCHA v2", html: '<div class="g-recaptcha" data-sitekey="6Lc_a"></div>' },
    {
      name: "reCAPTCHA v3 (invisible + action)",
      html: '<div class="g-recaptcha" data-sitekey="6Lc_b" data-size="invisible" data-action="login"></div>',
    },
    {
      name: "hCaptcha + Turnstile",
      html: '<div class="h-captcha" data-sitekey="hc-1"></div><div class="cf-turnstile" data-sitekey="cf-1"></div>',
    },
    {
      name: "GeeTest v3",
      html: '<div class="geetest_widget" data-gt="gt-key" data-challenge="ch-val"></div>',
    },
    {
      name: "GeeTest v4",
      html: '<div class="geetest_widget" data-captcha-id="cap-id-9"></div>',
    },
    {
      name: "Arkose / FunCaptcha",
      html: '<div class="funcaptcha" data-pkey="pk-abc"></div>',
    },
    { name: "Yandex SmartCaptcha", html: '<div class="smart-captcha" data-sitekey="ysc1"></div>' },
    { name: "Amazon WAF", html: '<div data-aws-waf-captcha="amz-sk"></div>' },
    { name: "Tencent", html: '<div id="tcaptcha" data-appid="tencent-app"></div>' },
    { name: "Capy Puzzle", html: '<div class="capy-captcha" data-capy-sitekey="capy-sk"></div>' },
    { name: "CyberSiARA", html: '<div id="cybersiara-box" data-cybersiara="siara-id"></div>' },
    { name: "MTCaptcha", html: '<div id="mtcaptcha" data-mtcaptcha-sitekey="mt-sk"></div>' },
    { name: "Friendly Captcha", html: '<div class="friendly-captcha" data-sitekey="fc-sk"></div>' },
    { name: "Cutcaptcha", html: '<div id="puzzle-captcha" data-puzzleid="cut-sk"></div>' },
    {
      name: "all 15 types together",
      html: `
        <div class="g-recaptcha" data-sitekey="rc"></div>
        <div class="g-recaptcha" data-sitekey="rc3" data-size="invisible" data-action="a"></div>
        <div class="h-captcha" data-sitekey="hc"></div>
        <div class="cf-turnstile" data-sitekey="ts"></div>
        <div class="geetest_widget" data-gt="gt" data-challenge="ch"></div>
        <div class="geetest_widget" data-captcha-id="cid"></div>
        <div class="funcaptcha" data-pkey="pk"></div>
        <div class="smart-captcha" data-sitekey="ya"></div>
        <div data-aws-waf-captcha="amz"></div>
        <div id="tcaptcha" data-appid="tc"></div>
        <div class="capy-captcha" data-capy-sitekey="cp"></div>
        <div id="cybersiara-box" data-cybersiara="cs"></div>
        <div id="mtcaptcha" data-mtcaptcha-sitekey="mt"></div>
        <div class="friendly-captcha" data-sitekey="fr"></div>
        <div id="puzzle-captcha" data-puzzleid="cu"></div>
      `,
    },
    { name: "no widgets (empty page)", html: '<div class="not-a-captcha">hello</div>' },
  ];

  for (const { name, html, setup } of cases) {
    it(`closure matches scanWidgets: ${name}`, () => {
      const pure = runPureScan(html, setup);
      const closure = runDetectClosure(html, setup);
      // The core assertion: the page-eval closure produces EXACTLY what the
      // pure function produces for the same DOM.
      expect(stripUrl(closure)).toEqual(stripUrl(pure as never));
    });
  }
});

describe("injectToken closure execution (jsdom realm)", () => {
  const cases: Array<{ name: string; type: CaptchaWidgetType; html: string; expectedWritten: boolean }> = [
    { name: "reCAPTCHA v2 → #g-recaptcha-response", type: "recaptcha_v2", html: '<textarea id="g-recaptcha-response"></textarea>', expectedWritten: true },
    { name: "reCAPTCHA v3 → g-recaptcha-response", type: "recaptcha_v3", html: '<textarea name="g-recaptcha-response"></textarea>', expectedWritten: true },
    { name: "hCaptcha → h-captcha-response", type: "hcaptcha", html: '<textarea name="h-captcha-response"></textarea>', expectedWritten: true },
    { name: "Turnstile → cf-turnstile-response", type: "turnstile", html: '<input name="cf-turnstile-response">', expectedWritten: true },
    { name: "GeeTest → geetest_validate", type: "geetest", html: '<input name="geetest_validate">', expectedWritten: true },
    { name: "GeeTest v4 → geetest_seccode", type: "geetest_v4", html: '<input name="geetest_seccode">', expectedWritten: true },
    { name: "FunCaptcha → fc-token", type: "funcaptcha", html: '<input name="fc-token">', expectedWritten: true },
    { name: "Yandex → smart-token", type: "yandex_smartcaptcha", html: '<input name="smart-token">', expectedWritten: true },
    { name: "Amazon → captcha-verifier", type: "amazon_waf", html: '<input name="captcha-verifier">', expectedWritten: true },
    { name: "Tencent → ticket", type: "tencent", html: '<input name="ticket">', expectedWritten: true },
    { name: "Capy → capy-captcha-response", type: "capy_puzzle", html: '<input name="capy-captcha-response">', expectedWritten: true },
    { name: "CyberSiARA → cybersiara-response", type: "cybersiara", html: '<input name="cybersiara-response">', expectedWritten: true },
    { name: "MTCaptcha → mtcaptcha-verifiedtoken", type: "mtcaptcha", html: '<input name="mtcaptcha-verifiedtoken">', expectedWritten: true },
    { name: "Friendly → frc-captcha-solution", type: "friendly_captcha", html: '<input name="frc-captcha-solution">', expectedWritten: true },
    { name: "Cutcaptcha → puzzle-captcha", type: "cutcaptcha", html: '<input name="puzzle-captcha">', expectedWritten: true },
    { name: "missing field → written=false", type: "recaptcha_v2", html: '<div>no field</div>', expectedWritten: false },
    { name: "image widget → no-op", type: "image_text", html: '<div></div>', expectedWritten: false },
  ];

  for (const { name, type, html, expectedWritten } of cases) {
    it(`${name}`, () => {
      const result = runInjectClosure(html, type, "SOLVED-TOKEN");
      expect(result.written ?? false).toBe(expectedWritten);
    });
  }
});
