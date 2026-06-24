import { describe, expect, it } from "vitest";
import { decodeMasterKey, decryptEnvelope, encryptEnvelope } from "./encryption.js";

describe("vault envelope encryption", () => {
  it("round trips plaintext with AES-256-GCM envelope encryption", () => {
    const masterKey = decodeMasterKey(Buffer.alloc(32, 7).toString("base64"));
    const envelope = encryptEnvelope(JSON.stringify({ password: "hunter2" }), masterKey);

    expect(envelope.algorithm).toBe("aes-256-gcm");
    expect(envelope.payload.ciphertext).not.toContain("hunter2");
    expect(JSON.parse(decryptEnvelope(envelope, masterKey).toString("utf8"))).toEqual({
      password: "hunter2",
    });
  });

  it("rejects tampered payloads", () => {
    const masterKey = decodeMasterKey(Buffer.alloc(32, 9).toString("base64"));
    const envelope = encryptEnvelope("secret", masterKey);
    envelope.payload.ciphertext = Buffer.from("tampered").toString("base64");

    expect(() => decryptEnvelope(envelope, masterKey)).toThrow();
  });
});
