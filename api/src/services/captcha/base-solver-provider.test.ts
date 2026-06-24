import { afterEach, describe, expect, it, vi } from "vitest";
import { AntiCaptchaProvider } from "./anti-captcha-provider.js";
import { CapMonsterProvider } from "./capmonster-provider.js";
import { CapSolverProvider } from "./capsolver-provider.js";
import { TwoCaptchaProvider } from "./two-captcha-provider.js";
import {
  CaptchaSolverError,
  CaptchaSolverRejectedError,
  CaptchaSolverTimeoutError,
} from "./captcha-provider.js";
import type { CaptchaSolverProvider, SolveRequest } from "./captcha-provider.js";

const widget = {
  type: "recaptcha_v2" as const,
  sitekey: "6Le-wvkS",
  url: "https://app.example.com/login",
};

const buildRequest = (): SolveRequest => ({ widget });

/**
 * Builds a fetch stub that returns `processing` for the first `readyAfter`
 * getTaskResult calls then `ready` with the token. createTask always returns a
 * taskId. Uses real (tiny) poll intervals — no fake timers — so promise
 * rejection is caught synchronously by the awaited expectation.
 */
const buildFetch = (readyAfter: number, token = "SOLVED_TOKEN") => {
  let getResultCalls = 0;
  return vi.fn(async (url: string | URL, _init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith("/getTaskResult")) {
      getResultCalls += 1;
      if (getResultCalls <= readyAfter) {
        return new Response(JSON.stringify({ errorId: 0, status: "processing" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          errorId: 0,
          status: "ready",
          solution: { gRecaptchaResponse: token },
          cost: 0.001,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ errorId: 0, taskId: 98765 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
};

const asFetch = (stub: ReturnType<typeof buildFetch>) =>
  stub as unknown as typeof fetch;

afterEach(() => {
  vi.unstubAllGlobals();
});

const cases: Array<[string, new (key: string) => CaptchaSolverProvider, string]> = [
  ["2captcha", TwoCaptchaProvider as never, "https://api.2captcha.com"],
  ["anti-captcha", AntiCaptchaProvider as never, "https://api.anti-captcha.com"],
  ["capmonster", CapMonsterProvider as never, "https://api.capmonster.cloud"],
  ["capsolver", CapSolverProvider as never, "https://api.capsolver.com"],
];

describe("solver providers (shared createTask/poll flow)", () => {
  for (const [name, Provider, expectedEndpoint] of cases) {
    describe(name, () => {
      it("submits createTask to the provider endpoint and polls until ready", async () => {
        const fetchStub = buildFetch(1);
        vi.stubGlobal("fetch", fetchStub);
        const provider = new Provider("key");

        const result = await provider.solve(buildRequest(), {
          timeoutMs: 2_000,
          pollIntervalMs: 1,
          fetch: asFetch(fetchStub),
        });

        expect(result.token).toBe("SOLVED_TOKEN");
        expect(result.providerTaskId).toBe("98765");
        expect(result.costUsd).toBe(0.001);

        const createCall = fetchStub.mock.calls.find(([u]) =>
          String(u).endsWith("/createTask"),
        );
        expect(createCall?.[0]).toBe(`${expectedEndpoint}/createTask`);
        const createBody = JSON.parse(
          String((createCall?.[1] as RequestInit | undefined)?.body),
        );
        expect(createBody.clientKey).toBe("key");
        expect(createBody.task.websiteURL).toBe(widget.url);
        expect(createBody.task.websiteKey).toBe(widget.sitekey);
      });

      it("rejects when the provider returns a non-zero errorId", async () => {
        const fetchStub = vi.fn(async () => new Response(
          JSON.stringify({
            errorId: 12,
            errorCode: "ERROR_KEY_DOES_NOT_EXIST",
            errorDescription: "bad key",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ));
        vi.stubGlobal("fetch", fetchStub);
        const provider = new Provider("key");

        await expect(
          provider.solve(buildRequest(), {
            timeoutMs: 1_000,
            pollIntervalMs: 1,
            fetch: asFetch(fetchStub),
          }),
        ).rejects.toMatchObject({
          name: "CaptchaSolverRejectedError",
          providerCode: "ERROR_KEY_DOES_NOT_EXIST",
        });
      });

      it("times out when never ready", async () => {
        const fetchStub = buildFetch(1_000_000); // never ready
        vi.stubGlobal("fetch", fetchStub);
        const provider = new Provider("key");

        await expect(
          provider.solve(buildRequest(), {
            timeoutMs: 30,
            pollIntervalMs: 5,
            fetch: asFetch(fetchStub),
          }),
        ).rejects.toBeInstanceOf(CaptchaSolverTimeoutError);
      });
    });
  }
});

describe("task-type-specific buildTask shapes", () => {
  const buildReadyFetch = (solution: Record<string, unknown>) =>
    vi.fn(async (url: string | URL, _init?: RequestInit) => {
      if (String(url).endsWith("/getTaskResult")) {
        return new Response(
          JSON.stringify({ errorId: 0, status: "ready", solution }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ errorId: 0, taskId: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" } as Record<string, string>,
      });
    });

  it("builds a GeeTest v3 task with gt + challenge", async () => {
    const fetchStub = buildReadyFetch({ seccode: "S", validate: "V", challenge: "C" });
    vi.stubGlobal("fetch", fetchStub);
    const provider = new TwoCaptchaProvider("key");
    await provider.solve(
      {
        widget: {
          type: "geetest",
          url: "https://app.example.com/page",
          gt: "gt-key",
          challenge: "ch-value",
        },
      },
      { timeoutMs: 1_000, pollIntervalMs: 1, fetch: asFetch(fetchStub) },
    );
    const createCall = fetchStub.mock.calls.find(([u]) => String(u).endsWith("/createTask"));
    const createBody = JSON.parse(String((createCall?.[1] as RequestInit | undefined)?.body));
    expect(createBody.task.type).toBe("GeeTestTaskProxyless");
    expect(createBody.task.gt).toBe("gt-key");
    expect(createBody.task.challenge).toBe("ch-value");
    expect(createBody.task.websiteURL).toBe("https://app.example.com/page");
  });

  it("builds a FunCaptcha task with websitePublicKey", async () => {
    const fetchStub = buildReadyFetch({ token: "FC-TOKEN" });
    vi.stubGlobal("fetch", fetchStub);
    const provider = new TwoCaptchaProvider("key");
    await provider.solve(
      {
        widget: {
          type: "funcaptcha",
          url: "https://app.example.com/page",
          publicKey: "pk-abc",
          serviceUrl: "https://client-api.arkoselabs.com",
        },
      },
      { timeoutMs: 1_000, pollIntervalMs: 1, fetch: asFetch(fetchStub) },
    );
    const createCall = fetchStub.mock.calls.find(([u]) => String(u).endsWith("/createTask"));
    const createBody = JSON.parse(String((createCall?.[1] as RequestInit | undefined)?.body));
    expect(createBody.task.type).toBe("FunCaptchaTaskProxyless");
    expect(createBody.task.websitePublicKey).toBe("pk-abc");
    expect(createBody.task.funcaptchaApiJSSubdomain).toBe("https://client-api.arkoselabs.com");
  });

  it("builds an image task with body carrying base64", async () => {
    const fetchStub = buildReadyFetch({ text: "HELLO" });
    vi.stubGlobal("fetch", fetchStub);
    const provider = new TwoCaptchaProvider("key");
    const result = await provider.solve(
      {
        widget: {
          type: "image_text",
          url: "https://app.example.com/page",
          imageBase64: "iVBORw0KGgo...",
          instructions: "Type the text",
        },
      },
      { timeoutMs: 1_000, pollIntervalMs: 1, fetch: asFetch(fetchStub) },
    );
    const createCall = fetchStub.mock.calls.find(([u]) => String(u).endsWith("/createTask"));
    const createBody = JSON.parse(String((createCall?.[1] as RequestInit | undefined)?.body));
    expect(createBody.task.type).toBe("ImageToTextTask");
    expect(createBody.task.body).toBe("iVBORw0KGgo...");
    expect(createBody.task.comment).toBe("Type the text");
    expect(result.text).toBe("HELLO");
  });

  it("extracts coordinates for an image_click result", async () => {
    const fetchStub = buildReadyFetch({
      coordinates: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
    });
    vi.stubGlobal("fetch", fetchStub);
    const provider = new TwoCaptchaProvider("key");
    const result = await provider.solve(
      {
        widget: {
          type: "image_click",
          url: "https://app.example.com/page",
          imageBase64: "img-data",
        },
      },
      { timeoutMs: 1_000, pollIntervalMs: 1, fetch: asFetch(fetchStub) },
    );
    expect(result.coordinates).toEqual([
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ]);
  });

  it("throws unsupported_widget when a provider does not support the type", async () => {
    const fetchStub = buildReadyFetch({ token: "T" });
    vi.stubGlobal("fetch", fetchStub);
    const provider = new CapSolverProvider("key");
    // CapSolver does not support image_click.
    await expect(
      provider.solve(
        { widget: { type: "image_click", url: "https://app.example.com/page", imageBase64: "x" } },
        { timeoutMs: 1_000, pollIntervalMs: 1, fetch: asFetch(fetchStub) },
      ),
    ).rejects.toMatchObject({ name: "CaptchaUnsupportedWidgetError" });
  });
});

describe("base provider error classification", () => {
  it("maps a transport failure to CaptchaSolverError", async () => {
    const fetchStub = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchStub);
    const provider = new AntiCaptchaProvider("key");

    await expect(
      provider.solve(buildRequest(), {
        timeoutMs: 1_000,
        pollIntervalMs: 1,
        fetch: asFetch(fetchStub),
      }),
    ).rejects.toMatchObject({
      name: "CaptchaSolverError",
      providerCode: "request_failed",
    });
  });

  it("rejects an empty token as CaptchaSolverRejectedError", async () => {
    const fetchStub = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/getTaskResult")) {
        return new Response(
          JSON.stringify({
            errorId: 0,
            status: "ready",
            solution: { gRecaptchaResponse: "" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ errorId: 0, taskId: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchStub);
    const provider = new AntiCaptchaProvider("key");

    await expect(
      provider.solve(buildRequest(), {
        timeoutMs: 1_000,
        pollIntervalMs: 1,
        fetch: asFetch(fetchStub),
      }),
    ).rejects.toMatchObject({
      name: "CaptchaSolverRejectedError",
      providerCode: "empty_token",
    });
  });
});
