import { afterEach, describe, expect, it, vi } from "vitest";
import { createCaptchaSolverService } from "./captcha-solver.service.js";

const widget = {
  type: "recaptcha_v2" as const,
  sitekey: "6Le-wvkS",
  url: "https://app.example.com/login",
};

/** A fetch stub that immediately returns `ready` with a token. */
const readyFetch = (token = "SOLVED_TOKEN") =>
  vi.fn(async (url: string | URL) => {
    if (String(url).endsWith("/getTaskResult")) {
      return new Response(
        JSON.stringify({
          errorId: 0,
          status: "ready",
          solution: { gRecaptchaResponse: token },
          cost: 0.002,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ errorId: 0, taskId: 42 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CaptchaSolverService gate", () => {
  it("returns disabled when not enabled and does no network I/O", async () => {
    const fetchStub = readyFetch();
    vi.stubGlobal("fetch", fetchStub);

    const service = createCaptchaSolverService({
      enabled: false,
      provider: "2captcha",
      apiKey: "key",
      allowedOrigins: "https://app.example.com",
      timeoutMs: 1_000,
      pollIntervalMs: 1,
    });

    expect(service.isEnabled()).toBe(false);
    expect(service.isAllowed(widget.url)).toBe(false);
    const outcome = await service.solve(widget);
    expect(outcome.status).toBe("disabled");
    expect(outcome.token).toBeUndefined();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("returns origin_not_allowed for an off-allowlist origin", async () => {
    const fetchStub = readyFetch();
    vi.stubGlobal("fetch", fetchStub);

    const service = createCaptchaSolverService({
      enabled: true,
      provider: "2captcha",
      apiKey: "key",
      allowedOrigins: "https://app.example.com",
      timeoutMs: 1_000,
      pollIntervalMs: 1,
    });

    expect(service.isAllowed("https://evil.example.org/login")).toBe(false);
    const outcome = await service.solve({ ...widget, url: "https://evil.example.org/login" });
    expect(outcome.status).toBe("origin_not_allowed");
    expect(outcome.allowedOrigin).toBe("https://evil.example.org");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("uses exact-origin matching (subdomains rejected, paths ignored)", () => {
    const service = createCaptchaSolverService({
      enabled: true,
      provider: "2captcha",
      apiKey: "key",
      allowedOrigins: "https://app.example.com",
      timeoutMs: 1_000,
      pollIntervalMs: 1,
    });

    expect(service.isAllowed("https://shop.example.com/login")).toBe(false);
    expect(service.isAllowed("https://app.example.com.evil.org/login")).toBe(false);
    expect(service.isAllowed("https://app.example.com/deep/path")).toBe(true);
  });

  it("throws at construction when enabled without an API key", () => {
    expect(() =>
      createCaptchaSolverService({
        enabled: true,
        provider: "2captcha",
        apiKey: undefined,
        allowedOrigins: "https://app.example.com",
        timeoutMs: 1_000,
        pollIntervalMs: 1,
      }),
    ).toThrow(/CAPTCHA_SOLVER_API_KEY/);
  });
});

describe("CaptchaSolverService solve (allowlisted origin)", () => {
  it("returns solved with a token via the configured provider", async () => {
    const fetchStub = readyFetch("SOLVED_TOKEN");
    vi.stubGlobal("fetch", fetchStub);

    const service = createCaptchaSolverService({
      enabled: true,
      provider: "2captcha",
      apiKey: "key",
      allowedOrigins: "https://app.example.com",
      timeoutMs: 5_000,
      pollIntervalMs: 1,
    });

    const outcome = await service.solve(widget);
    expect(outcome.status).toBe("solved");
    expect(outcome.token).toBe("SOLVED_TOKEN");
    expect(outcome.providerTaskId).toBe("42");
    expect(outcome.provider).toBe("2captcha");
    expect(fetchStub.mock.calls[0]?.[0]).toBe("https://api.2captcha.com/createTask");
  });

  it("never leaks the API key in the outcome payload", async () => {
    const fetchStub = vi.fn(async () => new Response(
      JSON.stringify({
        errorId: 13,
        errorCode: "ERROR_KEY_DOES_NOT_EXIST",
        errorDescription: "bad key",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchStub);

    const service = createCaptchaSolverService({
      enabled: true,
      provider: "2captcha",
      apiKey: "super-secret-key",
      allowedOrigins: "https://app.example.com",
      timeoutMs: 1_000,
      pollIntervalMs: 1,
    });

    const outcome = await service.solve(widget);
    expect(outcome.status).toBe("solver_error");
    expect(outcome.errorCode).toBe("ERROR_KEY_DOES_NOT_EXIST");
    expect(JSON.stringify(outcome)).not.toContain("super-secret-key");
  });
});

describe("CaptchaSolverService mode + wildcard gate", () => {
  it("returns detect_only and blocks solving in detect-only mode", async () => {
    const fetchStub = readyFetch("SOLVED");
    vi.stubGlobal("fetch", fetchStub);

    const service = createCaptchaSolverService({
      enabled: true,
      mode: "detect-only",
      provider: "2captcha",
      apiKey: "key",
      allowedOrigins: "https://app.example.com",
      timeoutMs: 1_000,
      pollIntervalMs: 1,
    });

    expect(service.canSolve()).toBe(false);
    const outcome = await service.solve(widget);
    expect(outcome.status).toBe("detect_only");
    expect(outcome.mode).toBe("detect-only");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("canSolve is true in auto mode and false when disabled", () => {
    const on = createCaptchaSolverService({
      enabled: true,
      mode: "auto",
      provider: "2captcha",
      apiKey: "key",
      allowedOrigins: "https://app.example.com",
      timeoutMs: 1_000,
      pollIntervalMs: 1,
    });
    const off = createCaptchaSolverService({
      enabled: false,
      provider: "2captcha",
      apiKey: "key",
      allowedOrigins: "https://app.example.com",
      timeoutMs: 1_000,
      pollIntervalMs: 1,
    });
    expect(on.canSolve()).toBe(true);
    expect(off.canSolve()).toBe(false);
  });

  it("wildcard origin mode allows an off-allowlist origin and reports originMode", async () => {
    const fetchStub = readyFetch("WILDCARD_TOKEN");
    vi.stubGlobal("fetch", fetchStub);

    const service = createCaptchaSolverService({
      enabled: true,
      mode: "auto",
      provider: "2captcha",
      apiKey: "key",
      allowedOrigins: "https://app.example.com",
      allowAnyOrigin: true,
      timeoutMs: 1_000,
      pollIntervalMs: 1,
    });

    // Off-allowlist origin is normally rejected, but wildcard allows it.
    const offAllowlist = { ...widget, url: "https://random.example.org/page" };
    expect(service.isAllowed(offAllowlist.url)).toBe(true);
    const outcome = await service.solve(offAllowlist);
    expect(outcome.status).toBe("solved");
    expect(outcome.token).toBe("WILDCARD_TOKEN");
    expect(outcome.originMode).toBe("wildcard");
  });
});
