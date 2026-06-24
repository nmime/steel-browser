import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createChallengeAssistanceService,
  normalizeAllowedOrigins,
  redactUrl,
} from "./challenge-assistance.service.js";

describe("challenge assistance service", () => {
  it("is disabled by default", () => {
    const service = createChallengeAssistanceService({ enabled: false, allowedOrigins: [] });

    expect(service.detectChallenge({ url: "https://example.com/challenge" })).toMatchObject({
      status: "disabled",
      assistanceEnabled: false,
    });
  });

  it("normalizes only exact origins in the allowlist", () => {
    expect(
      normalizeAllowedOrigins([
        "https://example.com",
        "https://example.com/",
        "https://example.com/path",
        "https://user@example.com",
        "not-a-url",
        "http://example.com:8080",
      ]),
    ).toEqual(["https://example.com", "http://example.com:8080"]);
  });

  it("rejects URLs outside the exact-origin allowlist", () => {
    const service = createChallengeAssistanceService({
      enabled: true,
      allowedOrigins: ["https://example.com"],
    });

    expect(service.reportChallenge({ url: "https://sub.example.com/challenge" })).toMatchObject({
      status: "origin_not_allowed",
      assistanceEnabled: true,
      allowedOrigin: "https://sub.example.com",
    });
  });

  it("detects challenge indicators without returning raw sensitive input", () => {
    const service = createChallengeAssistanceService({
      enabled: true,
      allowedOrigins: ["https://example.com"],
    });

    const result = service.detectChallenge({
      url: "https://user:pass@example.com/challenge?token=secret#frag",
      title: "Security check",
      visibleText:
        "Please verify you are human. Contact admin@example.com with bearer abcdefghijklmnopqrstuvwxyz123456.",
    });

    expect(result).toMatchObject({
      status: "detected",
      challenge: { suspected: true, kind: "bot_check" },
      redacted: { url: "https://example.com/challenge" },
    });
    expect(result.redacted?.visibleText).toContain("[REDACTED_EMAIL]");
    expect(result.redacted?.visibleText).toContain("[REDACTED_TOKEN]");
  });

  it("redacts URL credentials, query strings, and hashes", () => {
    expect(redactUrl("https://user:pass@example.com/path?session=secret#token")).toBe(
      "https://example.com/path",
    );
  });

  it("redacts sensitive metadata keys in reports", () => {
    const service = createChallengeAssistanceService({
      enabled: true,
      allowedOrigins: ["https://example.com"],
    });

    const result = service.reportChallenge({
      url: "https://example.com/challenge",
      kind: "captcha",
      metadata: {
        cookie: "session=secret",
        observation: "challenge visible",
      },
    });

    expect(result).toMatchObject({
      status: "reported",
      challenge: { kind: "captcha" },
      redacted: { metadata: { cookie: "[REDACTED]", observation: "challenge visible" } },
    });
  });

  it("creates manual handoff instructions only", () => {
    const service = createChallengeAssistanceService({
      enabled: true,
      allowedOrigins: ["https://example.com"],
    });

    const result = service.requestManualHandoff({
      url: "https://example.com/challenge",
      expiresInSeconds: 60,
    });

    expect(result.status).toBe("manual_handoff_required");
    expect(result.manualHandoff?.message).toContain("Manual handoff required");
    expect(result.manualHandoff).not.toHaveProperty("handoffUrl");
  });

  it("accepts owned-test callback only with a fresh valid HMAC", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const service = createChallengeAssistanceService({
      enabled: true,
      allowedOrigins: ["https://example.com"],
      ownedTestCallbackSecret: "test-secret",
      ownedTestCallbackMaxSkewMs: 60_000,
    });
    const body = {
      url: "https://example.com/challenge",
      testId: "owned-test-1",
      result: "shown" as const,
    };
    const payload = JSON.stringify(body);
    const timestamp = String(Date.now());
    const signature = createHmac("sha256", "test-secret")
      .update(`${timestamp}.${payload}`)
      .digest("hex");

    expect(
      service.handleOwnedTestCallback(body, payload, timestamp, `sha256=${signature}`),
    ).toMatchObject({
      status: "callback_accepted",
      reportId: "owned-test-1",
    });
    expect(service.handleOwnedTestCallback(body, payload, timestamp, "sha256=bad")).toMatchObject({
      status: "invalid_signature",
    });

    vi.useRealTimers();
  });
});
