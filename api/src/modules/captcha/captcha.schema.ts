import { FastifyRequest } from "fastify";
import { z } from "zod";

export const CaptchaWidgetType = z.enum([
  // Original token widgets.
  "recaptcha_v2",
  "recaptcha_v3",
  "hcaptcha",
  "turnstile",
  // Tier 1 token widgets.
  "geetest",
  "geetest_v4",
  "funcaptcha",
  "yandex_smartcaptcha",
  "amazon_waf",
  // Tier 2 token widgets.
  "tencent",
  "capy_puzzle",
  "cybersiara",
  "mtcaptcha",
  "friendly_captcha",
  "cutcaptcha",
  // Image / puzzle widgets.
  "image_text",
  "image_grid",
  "image_click",
  "image_rotate",
  "image_canvas",
  "image_audio",
]);

export const CaptchaWidgetDescriptor = z
  .object({
    type: CaptchaWidgetType,
    // Sitekey is optional — GeeTest/Arkose/image widgets key on other fields.
    sitekey: z.string().min(1).max(256).optional(),
    url: z
      .string()
      .url()
      .describe("Page URL the widget was found on. Only exact allowlisted origins are accepted."),
    selector: z.string().max(512).optional(),
    action: z.string().max(128).optional().describe("reCAPTCHA v3 action, if applicable."),
    // GeeTest v3 / v4.
    gt: z.string().max(256).optional(),
    challenge: z.string().max(512).optional(),
    captchaId: z.string().max(256).optional(),
    // Arkose / FunCaptcha.
    publicKey: z.string().max(256).optional(),
    serviceUrl: z.string().url().max(512).optional(),
    blob: z.string().max(2048).optional(),
    // Generic per-provider task id.
    taskId: z.string().max(256).optional(),
    // Image / puzzle widgets.
    imageBase64: z.string().max(5_000_000).optional(),
    imageGrid: z.array(z.string().max(5_000_000)).max(64).optional(),
    instructions: z.string().max(512).optional(),
    rows: z.number().int().min(1).max(32).optional(),
    cols: z.number().int().min(1).max(32).optional(),
    audioBase64: z.string().max(5_000_000).optional(),
    audioLang: z.string().max(16).optional(),
  })
  .strict();

const safeString = (max: number) => z.string().trim().max(max);

const CaptchaDetectRequest = z
  .object({
    url: z
      .string()
      .url()
      .describe("Page URL to inspect. Only exact allowlisted origins are accepted."),
    sessionId: safeString(128).optional().describe("Optional session id to validate the active session."),
  })
  .strict();

const CaptchaSolveRequest = z
  .object({
    url: z
      .string()
      .url()
      .describe("Page URL the widget is on. Only exact allowlisted origins are accepted."),
    sessionId: safeString(128).optional().describe("Optional session id to validate the active session."),
    widget: CaptchaWidgetDescriptor.optional().describe(
      "Known widget descriptor. Omit to auto-detect on the live page.",
    ),
  })
  .strict();

export const CaptchaSolverResponse = z.object({
  status: z.enum([
    "disabled",
    "detect_only",
    "origin_not_allowed",
    "session_unavailable",
    "widget_not_detected",
    "detected",
    "solver_error",
    "solved",
    "injected",
    "image_disabled",
    "image_capture_failed",
  ]),
  solverEnabled: z.boolean(),
  mode: z.enum(["off", "detect-only", "auto"]).optional(),
  originMode: z.enum(["allowlist", "wildcard"]).optional(),
  provider: z.string().optional(),
  allowedOrigin: z.string().optional(),
  widget: CaptchaWidgetDescriptor.optional(),
  widgets: z.array(CaptchaWidgetDescriptor).optional(),
  token: z.string().optional().describe("Solved token. Returned only after a successful solve."),
  text: z.string().optional().describe("Recognized text for image/puzzle widgets."),
  coordinates: z
    .array(z.object({ x: z.number(), y: z.number() }))
    .optional()
    .describe("Click coordinates in page space for image widgets."),
  angle: z.number().optional().describe("Rotation angle (degrees) for rotate widgets."),
  providerTaskId: z.string().optional(),
  injected: z.boolean().optional().describe("Whether the token/text/coords were written into the page."),
  redacted: z.object({
    url: z.string(),
  }),
  error: z.string().optional(),
  errorCode: z.string().optional(),
  safeHandling: z.array(z.string()),
});

export type CaptchaDetectBody = z.infer<typeof CaptchaDetectRequest>;
export type CaptchaDetectRequest = FastifyRequest<{ Body: CaptchaDetectBody }>;

export type CaptchaSolveBody = z.infer<typeof CaptchaSolveRequest>;
export type CaptchaSolveRequest = FastifyRequest<{ Body: CaptchaSolveBody }>;

export type CaptchaSolverResponseBody = z.infer<typeof CaptchaSolverResponse>;

export const captchaSchemas = {
  CaptchaDetectRequest,
  CaptchaSolveRequest,
  CaptchaSolverResponse,
};

export default captchaSchemas;
