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

  it("keeps owned-test auto disabled unless the explicit mode is selected", () => {
    const service = createChallengeAssistanceService({
      enabled: true,
      mode: "detect-only",
      allowedOrigins: ["https://example.com"],
    });

    expect(
      service.runOwnedTestAuto({
        url: "https://example.com/challenge",
        elements: [
          {
            selector: "#owned-answer",
            attributes: {
              "data-steel-owned-challenge": "true",
              "data-steel-owned-challenge-field": "answer",
              "data-steel-owned-challenge-value": "steel",
            },
          },
        ],
      }),
    ).toMatchObject({
      status: "owned_test_auto_rejected",
      ownedTestAuto: { status: "disabled", reason: "mode_not_owned_test_auto" },
    });
  });

  it("plans only safe fill and click actions for explicitly marked owned-test elements", () => {
    const service = createChallengeAssistanceService({
      enabled: false,
      mode: "owned-test-auto",
      allowedOrigins: ["https://example.com"],
    });

    const result = service.runOwnedTestAuto({
      url: "https://example.com/challenge?secret=redacted",
      fieldValues: { answer: "diploma-demo" },
      elements: [
        {
          selector: "#owned-answer",
          tagName: "input",
          attributes: {
            "data-steel-owned-challenge": "true",
            "data-steel-owned-challenge-field": "answer",
          },
        },
        {
          selector: "#owned-submit",
          tagName: "button",
          attributes: {
            "data-steel-owned-challenge": "true",
            "data-steel-owned-challenge-submit": "true",
          },
        },
      ],
    });

    expect(result).toMatchObject({
      status: "owned_test_auto_ready",
      assistanceEnabled: true,
      allowedOrigin: "https://example.com",
      redacted: { url: "https://example.com/challenge" },
      challenge: { provider: "owned-test-auto", kind: "bot_check" },
      ownedTestAuto: {
        provider: "owned-test-auto",
        mode: "owned-test-auto",
        status: "ready",
        scannedElements: 2,
        actions: [
          { type: "fill", selector: "#owned-answer", field: "answer", value: "diploma-demo" },
          { type: "click", selector: "#owned-submit" },
        ],
      },
    });
  });

  it("rejects owned-test auto when exact origin, owned markers, or real-widget guards fail", () => {
    const service = createChallengeAssistanceService({
      enabled: false,
      mode: "owned-test-auto",
      allowedOrigins: ["https://example.com"],
    });

    expect(
      service.runOwnedTestAuto({
        url: "https://sub.example.com/challenge",
        elements: [{ selector: "#owned", attributes: { "data-steel-owned-challenge": "true" } }],
      }),
    ).toMatchObject({ status: "origin_not_allowed" });

    expect(
      service.runOwnedTestAuto({
        url: "https://example.com/challenge",
        elements: [{ selector: "#owned", attributes: { "data-test-id": "challenge" } }],
      }),
    ).toMatchObject({
      status: "owned_test_auto_rejected",
      ownedTestAuto: { reason: "owned_marker_missing" },
    });

    expect(
      service.runOwnedTestAuto({
        url: "https://example.com/challenge",
        elements: [
          {
            selector: ".cf-turnstile",
            attributes: { "data-steel-owned-challenge": "true", "data-sitekey": "public" },
          },
        ],
      }),
    ).toMatchObject({
      status: "owned_test_auto_rejected",
      ownedTestAuto: { reason: "known_real_challenge_signal_detected" },
    });
  });
});
