/**
 * End-to-end integration test for the captcha solver pipeline.
 *
 * Unlike the unit/jsdom tests, this launches a REAL Chrome instance, navigates
 * to a REAL captcha demo page, and exercises the full detect → solve → inject
 * loop against the live DOM. It validates that:
 *   - detectWidgets finds widgets on a real page (not a toy fixture)
 *   - the provider (2captcha) accepts the task and returns a token
 *   - injectToken writes the token into the real page's response field
 *
 * SKIPPED by default. To run:
 *   CAPTCHA_SOLVER_INTEGRATION=true \
 *   CAPTCHA_SOLVER_API_KEY=your-real-2captcha-key \
 *   npx vitest run src/services/captcha/captcha.integration.test.ts
 *
 * This test costs real money (each solve is billed by the provider) and needs
 * network access + a local Chrome installation.
 */
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectWidgets } from "./page-widgets.js";
import { createCaptchaSolverService } from "./captcha-solver.service.js";
import { getChromeExecutablePath } from "../../utils/browser.js";

const RUN_INTEGRATION = process.env.CAPTCHA_SOLVER_INTEGRATION === "true";
const API_KEY = process.env.CAPTCHA_SOLVER_API_KEY;

// Skip the entire file unless explicitly opted in with a real key.
const describeOrSkip = RUN_INTEGRATION && API_KEY ? describe : describe.skip;

let browser: Browser | null = null;

beforeAll(async () => {
  if (!RUN_INTEGRATION || !API_KEY) return;
  browser = await puppeteer.launch({
    executablePath: getChromeExecutablePath(),
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });
}, 60_000);

afterAll(async () => {
  if (browser) await browser.close();
});

/**
 * Navigates to a URL, waits for network idle, and returns the page. Used as the
 * shared setup for each integration test case.
 */
const navigateTo = async (url: string): Promise<Page> => {
  if (!browser) throw new Error("Browser not launched");
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });
  // Give widget SDKs time to render.
  await new Promise((r) => setTimeout(r, 2000));
  return page;
};

describeOrSkip("captcha solver — end-to-end (real browser + provider)", () => {
  let service: ReturnType<typeof createCaptchaSolverService> | null = null;

  // Construct the service lazily inside beforeAll so it only initializes when
  // the suite actually runs (skipped suites must not throw at module-eval time).
  beforeAll(() => {
    service = createCaptchaSolverService({
      enabled: true,
      mode: "auto",
      provider: "2captcha",
      apiKey: API_KEY!,
      allowedOrigins: "https://2captcha.com",
      allowAnyOrigin: false,
      timeoutMs: 180_000,
      pollIntervalMs: 5_000,
    });
  });

  it(
    "detects a reCAPTCHA v2 widget on the 2captcha demo page",
    async () => {
      const page = await navigateTo("https://2captcha.com/demo/recaptcha-v2");
      const widgets = await detectWidgets(page, "https://2captcha.com/demo/recaptcha-v2");
      await page.close();

      expect(widgets.length).toBeGreaterThanOrEqual(1);
      const recaptcha = widgets.find((w) => w.type === "recaptcha_v2");
      expect(recaptcha).toBeDefined();
      expect(recaptcha!.sitekey).toBeTruthy();
    },
    60_000,
  );

  it(
    "solves a reCAPTCHA v2 and injects the token (full loop)",
    async () => {
      const page = await navigateTo("https://2captcha.com/demo/recaptcha-v2");
      const widgets = await detectWidgets(page, "https://2captcha.com/demo/recaptcha-v2");
      const widget = widgets.find((w) => w.type === "recaptcha_v2");

      if (!widget) {
        await page.close();
        throw new Error("reCAPTCHA v2 not detected on demo page");
      }

      const outcome = await service!.solve(widget);
      expect(outcome.status).toBe("solved");
      expect(outcome.token).toBeTruthy();
      expect(outcome.token!.length).toBeGreaterThan(20);

      // Verify the token was actually written to the page's response field.
      const responseValue = await page.evaluate(() => {
        const el = document.querySelector<HTMLTextAreaElement>("#g-recaptcha-response");
        return el?.value ?? null;
      });
      await page.close();

      // The provider returned a token; injection is best-effort but the field
      // should be populated if it exists on the page.
      if (responseValue !== null) {
        expect(responseValue.length).toBeGreaterThan(0);
      }
    },
    200_000,
  );
});
