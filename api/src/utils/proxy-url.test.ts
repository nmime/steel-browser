import { describe, expect, it } from "vitest";
import {
  applyProxyCredentials,
  normalizeProxyUrl,
  redactProxyUrl,
  resolveProxyUrl,
} from "./proxy-url.js";

describe("proxy URL utilities", () => {
  describe("normalizeProxyUrl", () => {
    it("adds an http protocol when one is omitted", () => {
      expect(normalizeProxyUrl("proxy.example.com:8080")).toBe("http://proxy.example.com:8080");
    });

    it("preserves supported explicit protocols", () => {
      expect(normalizeProxyUrl("https://proxy.example.com:8443")).toBe(
        "https://proxy.example.com:8443",
      );
      expect(normalizeProxyUrl("socks5://proxy.example.com:1080")).toBe(
        "socks5://proxy.example.com:1080",
      );
    });

    it("rejects empty values", () => {
      expect(() => normalizeProxyUrl("   ")).toThrow("Proxy URL must not be empty");
    });
  });

  describe("applyProxyCredentials", () => {
    it("adds configured credentials only when the URL has none", () => {
      expect(
        applyProxyCredentials("proxy.example.com:8080", {
          username: "env-user",
          password: "env-pass",
        }),
      ).toBe("http://env-user:env-pass@proxy.example.com:8080");
    });

    it("keeps URL credentials instead of overriding them", () => {
      expect(
        applyProxyCredentials("http://request-user:request-pass@proxy.example.com:8080", {
          username: "env-user",
          password: "env-pass",
        }),
      ).toBe("http://request-user:request-pass@proxy.example.com:8080");
    });
  });

  describe("resolveProxyUrl", () => {
    it("uses the request proxy before the global fallback", () => {
      expect(
        resolveProxyUrl("request.example.com:8080", {
          url: "fallback.example.com:8080",
        }),
      ).toBe("http://request.example.com:8080");
    });

    it("uses a configured global proxy when no request proxy is provided", () => {
      expect(
        resolveProxyUrl(undefined, {
          url: "fallback.example.com:8080",
          username: "user",
          password: "pass",
        }),
      ).toBe("http://user:pass@fallback.example.com:8080");
    });

    it("treats null as an explicit proxy disable even with a global fallback", () => {
      expect(
        resolveProxyUrl(null, {
          url: "fallback.example.com:8080",
        }),
      ).toBeUndefined();
    });

    it("returns undefined when no proxy is configured", () => {
      expect(resolveProxyUrl(undefined, {})).toBeUndefined();
    });
  });

  describe("redactProxyUrl", () => {
    it("redacts username and password", () => {
      expect(redactProxyUrl("http://user:secret@proxy.example.com:8080")).toBe(
        "http://redacted:redacted@proxy.example.com:8080",
      );
    });

    it("redacts username-only credentials", () => {
      expect(redactProxyUrl("http://user@proxy.example.com:8080")).toBe(
        "http://redacted:redacted@proxy.example.com:8080",
      );
    });

    it("leaves credential-free URLs normalized", () => {
      expect(redactProxyUrl("proxy.example.com:8080")).toBe("http://proxy.example.com:8080");
    });
  });
});
