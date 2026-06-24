import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

async function buildApp(mode = "owned-test-auto") {
  vi.resetModules();
  vi.stubEnv("CHALLENGE_ASSISTANCE_ENABLED", "false");
  vi.stubEnv("CHALLENGE_ASSISTANCE_MODE", mode);
  vi.stubEnv("CHALLENGE_ASSISTANCE_ALLOWED_ORIGINS", "https://example.com");

  const [{ default: openAPIPlugin }, { default: challengesRoutes }] = await Promise.all([
    import("../../plugins/schemas.js"),
    import("./challenges.routes.js"),
  ]);
  const app = Fastify({ logger: false });
  await app.register(openAPIPlugin);
  await app.register(challengesRoutes, { prefix: "/v1" });
  await app.ready();
  return app;
}

afterEach(() => vi.unstubAllEnvs());

describe("challenge assistance routes", () => {
  it("reports owned-test auto provider status and actions for marked harness elements", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/challenge-assistance/owned-test-auto",
      payload: {
        url: "https://example.com/challenge",
        fieldValues: { answer: "steel" },
        elements: [
          {
            selector: "#owned-answer",
            attributes: {
              "data-steel-owned-challenge": "true",
              "data-steel-owned-challenge-field": "answer",
            },
          },
          {
            selector: "#owned-submit",
            attributes: {
              "data-steel-owned-challenge": "true",
              "data-steel-owned-challenge-submit": "true",
            },
          },
        ],
      },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "owned_test_auto_ready",
      ownedTestAuto: {
        provider: "owned-test-auto",
        mode: "owned-test-auto",
        status: "ready",
        actions: [
          { type: "fill", selector: "#owned-answer", field: "answer", value: "steel" },
          { type: "click", selector: "#owned-submit" },
        ],
      },
    });
  });

  it("rejects owned-test auto route when the explicit mode is off", async () => {
    const app = await buildApp("detect-only");
    const response = await app.inject({
      method: "POST",
      url: "/v1/challenge-assistance/owned-test-auto",
      payload: {
        url: "https://example.com/challenge",
        elements: [
          {
            selector: "#owned",
            attributes: { "data-steel-owned-challenge": "true" },
          },
        ],
      },
    });
    await app.close();

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      status: "owned_test_auto_rejected",
      ownedTestAuto: { status: "disabled", reason: "mode_not_owned_test_auto" },
    });
  });
});
