import { describe, expect, it, vi } from "vitest";
import {
  findImageCaptchaElements,
  captureImage,
  captureAudio,
  applyText,
  applyCoordinates,
  applyAngle,
  applyImageResult,
} from "./page-image.js";
import type { ImageCaptchaFinding } from "./page-image.js";

/** A fake page with accessible vi.fn stubs for assertion. */
interface FakePage {
  evaluate: ReturnType<typeof vi.fn>;
  screenshot: ReturnType<typeof vi.fn>;
  $: ReturnType<typeof vi.fn>;
  target: () => unknown;
}

/**
 * Builds a fake CapturablePage with stubbed evaluate, screenshot, $, and target.
 * The `evaluate` stub is configurable to return whatever the test needs. Returns
 * a typed FakePage; cast to the narrow CapturablePage at the call site.
 */
const buildFakePage = (opts: {
  evaluate?: (...args: unknown[]) => unknown;
  screenshot?: (...args: unknown[]) => unknown;
  $?: (...args: unknown[]) => unknown;
  target?: () => unknown;
} = {}): FakePage => ({
  evaluate: vi.fn(opts.evaluate ?? (() => [])),
  screenshot: vi.fn(
    opts.screenshot ?? (() => "base64-image-data"),
  ),
  $: vi.fn(opts.$ ?? (() => null)),
  target: opts.target ?? (() => undefined),
});

/** Cast the fake to the narrow CapturablePage shape the SUT expects. */
const asPage = (fake: FakePage) => fake as never;

describe("findImageCaptchaElements", () => {
  it("returns findings from the page evaluate", async () => {
    const findings: ImageCaptchaFinding[] = [
      { type: "image_text", selector: "#captcha-image", boundingBox: { x: 0, y: 0, width: 100, height: 50 } },
    ];
    const page = buildFakePage({ evaluate: () => findings });
    const result = await findImageCaptchaElements(asPage(page));
    expect(result).toEqual(findings);
  });

  it("filters out findings without a boundingBox", async () => {
    const page = buildFakePage({
      evaluate: () => [
        { type: "image_text", selector: "#ok", boundingBox: { x: 0, y: 0, width: 10, height: 10 } },
        { type: "image_grid", selector: "#no-box" },
      ],
    });
    const result = await findImageCaptchaElements(asPage(page));
    expect(result).toHaveLength(1);
    expect(result[0].selector).toBe("#ok");
  });
});

describe("captureImage", () => {
  it("captures via element handle when available", async () => {
    const handle = { screenshot: vi.fn(() => "handle-b64") };
    const page = buildFakePage({ $: () => handle });
    const finding: ImageCaptchaFinding = {
      type: "image_text",
      selector: "#captcha-image",
      boundingBox: { x: 0, y: 0, width: 100, height: 50 },
    };
    const result = await captureImage(asPage(page), finding, 5_000_000);
    expect(result).toBe("handle-b64");
    expect(handle.screenshot).toHaveBeenCalledWith(
      expect.objectContaining({ encoding: "base64", type: "jpeg" }),
    );
  });

  it("falls back to clipped page screenshot when no handle", async () => {
    const page = buildFakePage({ $: () => null, screenshot: () => "clip-b64" });
    const finding: ImageCaptchaFinding = {
      type: "image_text",
      selector: "#captcha-image",
      boundingBox: { x: 10, y: 20, width: 100, height: 50 },
    };
    const result = await captureImage(asPage(page), finding, 5_000_000);
    expect(result).toBe("clip-b64");
    expect(page.screenshot).toHaveBeenCalledWith(
      expect.objectContaining({
        encoding: "base64",
        clip: { x: 10, y: 20, width: 100, height: 50 },
      }),
    );
  });

  it("throws when the image exceeds the byte cap", async () => {
    const page = buildFakePage({ $: () => null, screenshot: () => "x".repeat(100) });
    const finding: ImageCaptchaFinding = {
      type: "image_text",
      selector: "#captcha-image",
      boundingBox: { x: 0, y: 0, width: 10, height: 10 },
    };
    await expect(captureImage(asPage(page), finding, 50)).rejects.toThrow(/exceeds CAPTCHA_SOLVER_MAX_IMAGE_BYTES/);
  });
});

describe("captureAudio", () => {
  it("returns the base64 audio from evaluate", async () => {
    const page = buildFakePage({ evaluate: () => "audio-b64-data" });
    const finding: ImageCaptchaFinding = { type: "image_audio", selector: "#captcha-audio" };
    const result = await captureAudio(asPage(page), finding, 5_000_000);
    expect(result).toBe("audio-b64-data");
  });

  it("throws when the evaluate returns null (fetch failed)", async () => {
    const page = buildFakePage({ evaluate: () => null });
    const finding: ImageCaptchaFinding = { type: "image_audio", selector: "#captcha-audio" };
    await expect(captureAudio(asPage(page), finding, 5_000_000)).rejects.toThrow(/Failed to capture audio/);
  });
});

describe("applyText", () => {
  it("returns true when the answer input is found", async () => {
    const page = buildFakePage({ evaluate: () => true });
    expect(await applyText(asPage(page), "HELLO")).toBe(true);
  });

  it("returns false when no answer input exists", async () => {
    const page = buildFakePage({ evaluate: () => false });
    expect(await applyText(asPage(page), "HELLO")).toBe(false);
  });
});

describe("applyCoordinates", () => {
  it("dispatches pressed + released CDP mouse events for each coordinate", async () => {
    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
    const session = {
      send: vi.fn(async (method: string, params: Record<string, unknown>) => {
        sent.push({ method, params });
      }),
      detach: vi.fn(async () => {}),
    };
    const page = buildFakePage({
      target: () => ({ createCDPSession: async () => session }),
    });
    await applyCoordinates(asPage(page), [
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ]);
    expect(sent).toHaveLength(4); // 2 coords × (pressed + released)
    expect(sent[0]).toEqual({ method: "Input.dispatchMouseEvent", params: expect.objectContaining({ type: "mousePressed", x: 10, y: 20, button: "left" }) });
    expect(sent[1]).toEqual({ method: "Input.dispatchMouseEvent", params: expect.objectContaining({ type: "mouseReleased", x: 10, y: 20 }) });
    expect(sent[2].params).toMatchObject({ x: 30, y: 40 });
  });

  it("is a no-op when coordinates is empty", async () => {
    const page = buildFakePage();
    await applyCoordinates(asPage(page), []);
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});

describe("applyAngle", () => {
  it("sets the rotate slider value", async () => {
    const page = buildFakePage({ evaluate: () => true });
    expect(await applyAngle(asPage(page), 90)).toBe(true);
  });

  it("returns false when no rotate control exists", async () => {
    const page = buildFakePage({ evaluate: () => false });
    expect(await applyAngle(asPage(page), 90)).toBe(false);
  });
});

describe("applyImageResult", () => {
  it("applies text result via applyText", async () => {
    const page = buildFakePage({ evaluate: () => true });
    const result = await applyImageResult(asPage(page), { type: "image_text", url: "https://x" }, { text: "ABC" });
    expect(result).toBe(true);
  });

  it("returns false when nothing applicable", async () => {
    const page = buildFakePage({ evaluate: () => false });
    const result = await applyImageResult(asPage(page), { type: "image_text", url: "https://x" }, {});
    expect(result).toBe(false);
  });
});
