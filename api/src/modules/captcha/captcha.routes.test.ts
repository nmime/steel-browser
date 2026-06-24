import Fastify, { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

const URL = "https://app.example.com/login";
const WIDGET_BODY = {
  type: "recaptcha_v2",
  sitekey: "6Lc_a",
  url: URL,
};

/** Builds a fake cdpService that yields a fake page with stubbed evaluate. */
const buildFakeCdp = (pageEval: (...args: unknown[]) => unknown) => ({
  isRunning: () => true,
  launch: vi.fn(async () => {}),
  getPrimaryPage: vi.fn(async () => ({ evaluate: vi.fn(pageEval) })),
});

const buildFakeSession = () => ({
  activeSession: { id: "sess-active" },
});

async function buildApp(
  opts: {
    enabled?: boolean;
    apiKey?: string;
    fetchImpl?: unknown;
    pageEval?: (...args: unknown[]) => unknown;
    mode?: string;
    imageEnabled?: boolean;
  } = {},
): Promise<FastifyInstance> {
  vi.resetModules();
  vi.stubEnv("CAPTCHA_SOLVER_ENABLED", opts.enabled === false ? "false" : "true");
  vi.stubEnv("CAPTCHA_SOLVER_MODE", opts.mode ?? "auto");
  vi.stubEnv("CAPTCHA_SOLVER_PROVIDER", "2captcha");
  vi.stubEnv("CAPTCHA_SOLVER_API_KEY", opts.apiKey ?? "test-key");
  vi.stubEnv("CAPTCHA_SOLVER_ALLOWED_ORIGINS", "https://app.example.com");
  vi.stubEnv("CAPTCHA_SOLVER_ALLOW_ANY_ORIGIN", "false");
  vi.stubEnv("CAPTCHA_SOLVER_TIMEOUT_MS", "5000");
  vi.stubEnv("CAPTCHA_SOLVER_POLL_INTERVAL_MS", "1");
  vi.stubEnv("CAPTCHA_SOLVER_IMAGE_ENABLED", opts.imageEnabled ? "true" : "false");
  vi.stubEnv("CAPTCHA_SOLVER_MAX_IMAGE_BYTES", "5242880");

  if (opts.fetchImpl) vi.stubGlobal("fetch", opts.fetchImpl);

  const [{ default: openAPIPlugin }, { default: captchaRoutes }] = await Promise.all([
    import("../../plugins/schemas.js"),
    import("./captcha.routes.js"),
  ]);
  const app = Fastify({ logger: false });
  await app.register(openAPIPlugin);
  app.decorate(
    "cdpService",
    buildFakeCdp(opts.pageEval ?? (() => [])) as never,
  );
  app.decorate("sessionService", buildFakeSession() as never);
  await app.register(captchaRoutes, { prefix: "/v1" });
  await app.ready();
  return app;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("captcha routes — gate", () => {
  it("returns 403 disabled when the solver is disabled", async () => {
    const app = await buildApp({ enabled: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/captcha/detect",
      payload: { url: URL },
    });
    await app.close();

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      status: "disabled",
      solverEnabled: false,
    });
  });

  it("returns 403 origin_not_allowed for an off-allowlist origin", async () => {
    const app = await buildApp({});
    const response = await app.inject({
      method: "POST",
      url: "/v1/captcha/detect",
      payload: { url: "https://evil.example.org/login" },
    });
    await app.close();

    expect(response.statusCode).toBe(403);
    expect(response.json().status).toBe("origin_not_allowed");
  });
});

describe("captcha routes — detect", () => {
  it("returns 422 widget_not_detected when the page has no widgets", async () => {
    const app = await buildApp({ pageEval: () => [] });
    const response = await app.inject({
      method: "POST",
      url: "/v1/captcha/detect",
      payload: { url: URL },
    });
    await app.close();

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ status: "widget_not_detected" });
  });

  it("returns 200 detected with widgets", async () => {
    const app = await buildApp({
      pageEval: () => [
        { type: "recaptcha_v2", sitekey: "6Lc_a", selector: "#r" },
      ],
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/captcha/detect",
      payload: { url: URL },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("detected");
    expect(body.widgets).toEqual([
      { type: "recaptcha_v2", sitekey: "6Lc_a", url: URL, selector: "#r" },
    ]);
  });
});

describe("captcha routes — solve", () => {
  it("solves via the provider and injects the token (status injected)", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/getTaskResult")) {
        return new Response(
          JSON.stringify({
            errorId: 0,
            status: "ready",
            solution: { gRecaptchaResponse: "SOLVED" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ errorId: 0, taskId: 9 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    // page evaluate: detect returns the widget; injectToken returns {written:true}
    let evalCall = 0;
    const pageEval = () => {
      evalCall += 1;
      return evalCall === 1
        ? [{ type: "recaptcha_v2", sitekey: "6Lc_a", selector: "#r" }]
        : { written: true };
    };

    const app = await buildApp({ fetchImpl, pageEval });
    const response = await app.inject({
      method: "POST",
      url: "/v1/captcha/solve",
      payload: { url: URL },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      status: "injected",
      provider: "2captcha",
      token: "SOLVED",
      providerTaskId: "9",
      injected: true,
    });
    expect(body.widget.type).toBe("recaptcha_v2");
  });

  it("accepts an explicit widget and skips page detection", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/getTaskResult")) {
        return new Response(
          JSON.stringify({ errorId: 0, status: "ready", solution: { gRecaptchaResponse: "T" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ errorId: 0, taskId: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    // Only the injectToken evaluate should run; detection is skipped.
    const pageEval = () => ({ written: false });

    const app = await buildApp({ fetchImpl, pageEval });
    const response = await app.inject({
      method: "POST",
      url: "/v1/captcha/solve",
      payload: { url: URL, widget: WIDGET_BODY },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "injected", token: "T", injected: false });
  });

  it("returns 422 solver_error when the provider rejects", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({
        errorId: 12,
        errorCode: "ERROR_KEY_DOES_NOT_EXIST",
        errorDescription: "bad key",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const pageEval = () => ({ written: true });

    const app = await buildApp({ fetchImpl, pageEval });
    const response = await app.inject({
      method: "POST",
      url: "/v1/captcha/solve",
      payload: { url: URL, widget: WIDGET_BODY },
    });
    await app.close();

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      status: "solver_error",
      errorCode: "ERROR_KEY_DOES_NOT_EXIST",
    });
  });
});

describe("captcha routes — mode + image gate", () => {
  it("returns 403 detect_only when solving in detect-only mode", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ errorId: 0, taskId: 1 }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const app = await buildApp({ fetchImpl, mode: "detect-only" });
    const response = await app.inject({
      method: "POST",
      url: "/v1/captcha/solve",
      payload: { url: URL, widget: WIDGET_BODY },
    });
    await app.close();

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ status: "detect_only", mode: "detect-only" });
    // No provider call should have happened.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns 403 image_disabled for an image widget when image solving is off", async () => {
    const app = await buildApp({ mode: "auto", imageEnabled: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/captcha/solve",
      payload: { url: URL, widget: { type: "image_text", url: URL } },
    });
    await app.close();

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ status: "image_disabled" });
  });

  it("detect-only mode still allows /detect", async () => {
    const app = await buildApp({
      mode: "detect-only",
      pageEval: () => [{ type: "recaptcha_v2", sitekey: "6Lc_a", selector: "#r" }],
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/captcha/detect",
      payload: { url: URL },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "detected" });
  });
});
