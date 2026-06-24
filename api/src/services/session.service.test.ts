import { describe, expect, it } from "vitest";
import { normalizeSessionCredentials, resolveSessionUserDataDir } from "./session.service.js";

describe("session service helpers", () => {
  it("honors explicit userDataDir before persist/env defaults", () => {
    expect(
      resolveSessionUserDataDir({
        userDataDir: "/materialized/profile",
        persist: true,
        chromeUserDataDir: "/env/profile",
      }),
    ).toBe("/materialized/profile");
  });

  it("uses configured env user data dir when no explicit or persisted profile is requested", () => {
    expect(resolveSessionUserDataDir({ chromeUserDataDir: "/env/profile" })).toBe("/env/profile");
  });

  it("does not enable credential auto-submit by default", () => {
    expect(normalizeSessionCredentials({ blurFields: true, autoSubmit: false })).toEqual({
      blurFields: true,
      autoSubmit: false,
    });
  });
});
