import { describe, expect, it } from "vitest";
import { totp } from "./totp.js";

describe("totp", () => {
  it("matches RFC 6238 appendix B vectors", () => {
    const cases = [
      [59, "94287082", "46119246", "90693936"],
      [1111111109, "07081804", "68084774", "25091201"],
      [1111111111, "14050471", "67062674", "99943326"],
      [1234567890, "89005924", "91819424", "93441116"],
      [2000000000, "69279037", "90698825", "38618901"],
      [20000000000, "65353130", "77737706", "47863826"],
    ] as const;

    for (const [time, sha1, sha256, sha512] of cases) {
      expect(
        totp({
          secret: "12345678901234567890",
          encoding: "ascii",
          algorithm: "sha1",
          digits: 8,
          time,
        }),
      ).toBe(sha1);
      expect(
        totp({
          secret: "12345678901234567890123456789012",
          encoding: "ascii",
          algorithm: "sha256",
          digits: 8,
          time,
        }),
      ).toBe(sha256);
      expect(
        totp({
          secret: "1234567890123456789012345678901234567890123456789012345678901234",
          encoding: "ascii",
          algorithm: "sha512",
          digits: 8,
          time,
        }),
      ).toBe(sha512);
    }
  });
});
