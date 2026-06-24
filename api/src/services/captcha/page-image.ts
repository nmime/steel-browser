/**
 * Image / puzzle CAPTCHA pipeline: detect, capture, and apply.
 *
 * Unlike token widgets (sitekey → provider → token → inject), image/puzzle
 * captchas require capturing live-page pixels/audio and shipping them to the
 * provider, then applying the returned text or click coordinates back onto the
 * page. This is a distinct, heavier, and more privacy-sensitive flow:
 *
 *   - detection: locate captcha containers (`<img>`, `<canvas>`, `<audio>`)
 *   - capture:   `element.screenshot()` / `page.screenshot({clip})` → base64,
 *                size-capped by CAPTCHA_SOLVER_MAX_IMAGE_BYTES
 *   - apply:     fill returned text, or click returned coordinates via CDP
 *                `Input.dispatchMouseEvent` (mirrors casting.handler.ts)
 *
 * Everything here runs only after the gate + the separate
 * CAPTCHA_SOLVER_IMAGE_ENABLED flag have both passed — page pixels/audio are
 * exfiltrated to a third party, so image solving is opt-in on its own.
 */
import type { Page, CDPSession } from "puppeteer-core";
import type { CaptchaWidgetDescriptor, CaptchaWidgetType } from "./captcha-provider.js";
import { IMAGE_WIDGET_TYPES } from "./captcha-provider.js";

/** Minimal Page view these helpers need. */
type CapturablePage = Pick<Page, "evaluate" | "screenshot" | "$" | "target">;

/** A discovered image/puzzle widget on the page. */
export interface ImageCaptchaFinding {
  type: (typeof IMAGE_WIDGET_TYPES)[number];
  selector: string;
  instructions?: string;
  /** Bounding box in CSS pixels (page space), used for clipping + coordinate clicks. */
  boundingBox?: { x: number; y: number; width: number; height: number };
}

/** Pure classifier shared with the route/service layer. */
export const isImageFindingType = (type: CaptchaWidgetType): boolean =>
  (IMAGE_WIDGET_TYPES as ReadonlyArray<string>).includes(type);

/**
 * Scans the live page for image/puzzle captcha containers. Returns best-effort
 * findings; the caller decides whether to solve. Self-contained closure because
 * puppeteer serializes the evaluate callback.
 */
export async function findImageCaptchaElements(
  page: CapturablePage,
): Promise<ImageCaptchaFinding[]> {
  const raw = await page.evaluate(async () => {
    const findings: Array<{
      type: string;
      selector: string;
      instructions?: string;
      boundingBox?: { x: number; y: number; width: number; height: number };
    }> = [];

    const groups: Record<string, string[]> = {
      image_text: [".captcha-image", "#captcha-image", "img.captcha", "#captcha img"],
      image_grid: [".captcha-grid", "#captcha-grid", "img.grid-cell"],
      image_click: [".captcha-click", "#captcha-click", "img.click-captcha"],
      image_rotate: [".captcha-rotate", "#captcha-rotate"],
      image_canvas: ["canvas.captcha", "#captcha-canvas", ".puzzle-canvas"],
      image_audio: ["audio.captcha", "#captcha-audio", "audio[src]"],
    };

    for (const [type, selectors] of Object.entries(groups)) {
      for (const sel of selectors) {
        const el = document.querySelector<HTMLElement>(sel);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const selector =
          el.id ? `#${el.id}` : el.className ? `${el.tagName.toLowerCase()}.${el.className.split(/\s+/)[0]}` : sel;
        findings.push({
          type,
          selector,
          instructions:
            (document.querySelector<HTMLElement>(".captcha-instructions, #captcha-instructions")?.textContent ??
              undefined)?.slice(0, 512) || undefined,
          boundingBox:
            rect.width > 0 && rect.height > 0
              ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
              : undefined,
        });
        break; // one per type is enough
      }
    }
    return findings;
  });

  return (raw as ImageCaptchaFinding[]).filter((f) => f.boundingBox);
}

/**
 * Captures a single image widget as base64 (no data: prefix), clipped to its
 * bounding box. Prefers element-handle capture; falls back to a clipped
 * full-page screenshot when the handle is unavailable. Enforces the
 * `maxBytes` cap on the resulting base64 payload.
 */
export async function captureImage(
  page: CapturablePage,
  finding: ImageCaptchaFinding,
  maxBytes: number,
): Promise<string> {
  let base64: string | undefined;

  // Preferred path: element handle screenshot (clean, no clip math needed).
  if (finding.selector && typeof page.$ === "function") {
    const handle = await page.$(finding.selector);
    if (handle && typeof (handle as { screenshot?: unknown }).screenshot === "function") {
      const buf = await (handle as { screenshot: (o: unknown) => Promise<string> }).screenshot({
        encoding: "base64",
        type: "jpeg",
        quality: 100,
      });
      base64 = typeof buf === "string" ? buf : undefined;
    }
  }

  // Fallback: clipped full-page screenshot using the cached bounding box.
  if (!base64 && finding.boundingBox) {
    const buf = await page.screenshot({
      encoding: "base64",
      type: "jpeg",
      quality: 100,
      clip: {
        x: finding.boundingBox.x,
        y: finding.boundingBox.y,
        width: finding.boundingBox.width,
        height: finding.boundingBox.height,
      },
    });
    base64 = typeof buf === "string" ? buf : undefined;
  }

  if (!base64) throw new Error(`Failed to capture image captcha at ${finding.selector}`);
  if (base64.length > maxBytes) {
    throw new Error(
      `Captured image captcha (${base64.length} bytes) exceeds CAPTCHA_SOLVER_MAX_IMAGE_BYTES (${maxBytes})`,
    );
  }
  return base64;
}

/**
 * Captures audio for an `image_audio` widget by fetching its `<audio>` src and
 * base64-encoding the response. Minimal by design — audio captchas are rare.
 */
export async function captureAudio(
  page: CapturablePage,
  finding: ImageCaptchaFinding,
  maxBytes: number,
): Promise<string> {
  if (!finding.selector) throw new Error("Audio capture requires a selector");
  const dataUrl = await page.evaluate(async (selector: string) => {
    const audio = document.querySelector<HTMLAudioElement>(selector);
    const src = audio?.src;
    if (!src) return null;
    try {
      const resp = await fetch(src);
      const buf = await resp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    } catch {
      return null;
    }
  }, finding.selector);

  if (!dataUrl || typeof dataUrl !== "string") {
    throw new Error(`Failed to capture audio captcha at ${finding.selector}`);
  }
  if (dataUrl.length > maxBytes) {
    throw new Error(
      `Captured audio captcha (${dataUrl.length} bytes) exceeds CAPTCHA_SOLVER_MAX_IMAGE_BYTES (${maxBytes})`,
    );
  }
  return dataUrl;
}

/**
 * Applies a recognized-text result by filling the captcha answer input. Mirrors
 * the actions-module fill style: set value, dispatch input + change.
 */
export async function applyText(
  page: CapturablePage,
  text: string,
): Promise<boolean> {
  const result = await page.evaluate((value: string) => {
    const input =
      document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        "#captcha-answer, .captcha-answer, input[name='captcha'], input[name='captcha_answer']",
      ) ?? null;
    if (!input) return false;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, text);
  return Boolean(result);
}

/**
 * Clicks returned coordinates via CDP `Input.dispatchMouseEvent`, modeled on
 * casting.handler.ts. Each coordinate is in page space (provider returns
 * image-space coords; the caller is expected to map them if the image was
 * scaled). Emits pressed + released pairs to form real clicks.
 */
export async function applyCoordinates(
  page: CapturablePage,
  coordinates: Array<{ x: number; y: number }>,
): Promise<void> {
  if (!coordinates.length) return;
  const target = (page as Page & { target?: () => { createCDPSession(): Promise<CDPSession> } }).target?.();
  if (!target || typeof target.createCDPSession !== "function") {
    throw new Error("Page target does not support createCDPSession; cannot dispatch clicks");
  }
  const session = await target.createCDPSession();
  try {
    for (const { x, y } of coordinates) {
      await session.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await session.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
    }
  } finally {
    await session.detach().catch(() => {});
  }
}

/**
 * Applies a rotation result. The provider returns an angle in degrees; some
 * puzzle widgets expose a slider or rotate control. We dispatch a synthetic
 * wheel/rotate where a control exists; this is best-effort.
 */
export async function applyAngle(
  page: CapturablePage,
  angle: number,
): Promise<boolean> {
  const result = await page.evaluate((degrees: number) => {
    const control = document.querySelector<HTMLInputElement>(
      "input[type='range'].captcha-rotate, #captcha-rotate-input",
    );
    if (!control) return false;
    // Normalize angle to the slider's range (assume 0–360).
    const clamped = Math.max(0, Math.min(360, degrees));
    control.value = String(clamped);
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, angle);
  return Boolean(result);
}

/**
 * Convenience: applies whatever a SolveResult carries for an image widget.
 * Returns whether anything was applied (mirrors `injectToken`'s boolean).
 */
export async function applyImageResult(
  page: CapturablePage,
  widget: CaptchaWidgetDescriptor,
  result: { text?: string; coordinates?: Array<{ x: number; y: number }>; angle?: number },
): Promise<boolean> {
  let applied = false;
  if (result.text) applied = (await applyText(page, result.text)) || applied;
  if (result.coordinates?.length) {
    await applyCoordinates(page, result.coordinates);
    applied = true;
  }
  if (typeof result.angle === "number") applied = (await applyAngle(page, result.angle)) || applied;
  void widget;
  return applied;
}
