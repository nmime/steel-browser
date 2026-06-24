import { createHmac } from "node:crypto";

export type TotpAlgorithm = "sha1" | "sha256" | "sha512";
export type SecretEncoding = "ascii" | "utf8" | "base32" | "hex" | "base64";

export type HotpOptions = {
  secret: string | Buffer;
  counter: number | bigint;
  digits?: number;
  algorithm?: TotpAlgorithm;
  encoding?: SecretEncoding;
};

export type TotpOptions = Omit<HotpOptions, "counter"> & {
  time?: number | Date;
  period?: number;
  t0?: number;
};

export function hotp(options: HotpOptions): string {
  const digits = options.digits ?? 6;
  if (!Number.isInteger(digits) || digits <= 0 || digits > 10) {
    throw new Error("HOTP digits must be an integer between 1 and 10");
  }

  const counter = BigInt(options.counter);
  if (counter < 0n) {
    throw new Error("HOTP counter must be non-negative");
  }

  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(Number((counter >> 32n) & 0xffffffffn), 0);
  counterBuffer.writeUInt32BE(Number(counter & 0xffffffffn), 4);

  const hmac = createHmac(
    options.algorithm ?? "sha1",
    decodeSecret(options.secret, options.encoding),
  );
  hmac.update(counterBuffer);
  const digest = hmac.digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(code % 10 ** digits).padStart(digits, "0");
}

export function totp(options: TotpOptions): string {
  const period = options.period ?? 30;
  const t0 = options.t0 ?? 0;
  if (!Number.isFinite(period) || period <= 0) {
    throw new Error("TOTP period must be positive");
  }

  const unixSeconds = normalizeTime(options.time ?? Date.now());
  const counter = Math.floor((unixSeconds - t0) / period);
  return hotp({ ...options, counter });
}

export function decodeSecret(secret: string | Buffer, encoding: SecretEncoding = "base32"): Buffer {
  if (Buffer.isBuffer(secret)) {
    return Buffer.from(secret);
  }

  if (encoding === "base32") {
    return decodeBase32(secret);
  }

  return Buffer.from(secret, encoding);
}

function normalizeTime(time: number | Date): number {
  if (time instanceof Date) {
    return Math.floor(time.getTime() / 1000);
  }

  // Treat large epoch values as milliseconds, small RFC/test values as seconds.
  return time > 1_000_000_000_000 ? Math.floor(time / 1000) : Math.floor(time);
}

function decodeBase32(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = value.toUpperCase().replace(/[\s=-]/g, "");
  let bits = "";
  const bytes: number[] = [];

  for (const char of normalized) {
    const index = alphabet.indexOf(char);
    if (index === -1) {
      throw new Error("Invalid base32 secret");
    }
    bits += index.toString(2).padStart(5, "0");
    while (bits.length >= 8) {
      bytes.push(Number.parseInt(bits.slice(0, 8), 2));
      bits = bits.slice(8);
    }
  }

  return Buffer.from(bytes);
}
