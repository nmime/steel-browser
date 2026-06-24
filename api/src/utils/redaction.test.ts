import { describe, expect, it } from "vitest";
import { REDACTED, redactSensitiveData, redactUrl } from "./redaction.js";

describe("redaction utilities", () => {
  it("redacts credentials and sensitive query params from urls", () => {
    expect(redactUrl("https://user:pass@example.com/path?api_key=abc&keep=value&token=def")).toBe(
      `https://${REDACTED}:${REDACTED}@example.com/path?api_key=${REDACTED}&keep=value&token=${REDACTED}`,
    );
  });

  it("redacts nested sensitive values without mutating safe keys", () => {
    expect(
      redactSensitiveData({
        authorization: "Bearer secret",
        nested: {
          password: "hidden",
          safe: "https://example.com/?page=1",
        },
      }),
    ).toEqual({
      authorization: REDACTED,
      nested: {
        password: REDACTED,
        safe: "https://example.com/?page=1",
      },
    });
  });

  it("redacts auth foundation keys and audit metadata", () => {
    expect(
      redactSensitiveData({ "x-api-key": "secret", jwt: "secret", metadata: { apiKey: "secret" } }),
    ).toEqual({
      "x-api-key": REDACTED,
      jwt: REDACTED,
      metadata: { apiKey: REDACTED },
    });
  });

  it("preserves relative urls when redacting query params", () => {
    expect(redactUrl("/v1/sessions?token=secret&page=1")).toBe(
      `/v1/sessions?token=${REDACTED}&page=1`,
    );
  });

  it("does not rewrite ordinary strings as relative URLs", () => {
    expect(redactUrl("alice")).toBe("alice");
  });
});
