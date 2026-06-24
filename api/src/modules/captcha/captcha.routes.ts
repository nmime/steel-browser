import { FastifyInstance, FastifyReply } from "fastify";
import { env } from "../../env.js";
import { $ref } from "../../plugins/schemas.js";
import { createCaptchaSolverService, CAPTCHA_SOLVER_SAFE_HANDLING } from "../../services/captcha/captcha-solver.service.js";
import { detectWidgets, injectToken } from "../../services/captcha/page-widgets.js";
import {
  findImageCaptchaElements,
  captureImage,
  captureAudio,
  applyImageResult,
} from "../../services/captcha/page-image.js";
import { isImageType } from "../../services/captcha/captcha-provider.js";
import type { CaptchaWidgetDescriptor } from "../../services/captcha/captcha-provider.js";
import type { Page } from "puppeteer-core";
import type {
  CaptchaDetectRequest,
  CaptchaSolveRequest,
  CaptchaSolverResponseBody,
} from "./captcha.schema.js";

const service = createCaptchaSolverService(
  {
    enabled: env.CAPTCHA_SOLVER_ENABLED,
    mode: env.CAPTCHA_SOLVER_MODE,
    provider: env.CAPTCHA_SOLVER_PROVIDER,
    apiKey: env.CAPTCHA_SOLVER_API_KEY,
    allowedOrigins: env.CAPTCHA_SOLVER_ALLOWED_ORIGINS,
    allowAnyOrigin: env.CAPTCHA_SOLVER_ALLOW_ANY_ORIGIN,
    timeoutMs: env.CAPTCHA_SOLVER_TIMEOUT_MS,
    pollIntervalMs: env.CAPTCHA_SOLVER_POLL_INTERVAL_MS,
  },
  undefined,
);

const base = (
  overrides: Partial<CaptchaSolverResponseBody> = {},
): CaptchaSolverResponseBody => ({
  status: "disabled",
  solverEnabled: service.isEnabled(),
  redacted: { url: "" },
  safeHandling: CAPTCHA_SOLVER_SAFE_HANDLING,
  ...overrides,
});

const statusCodeFor = (result: CaptchaSolverResponseBody): number => {
  switch (result.status) {
    case "disabled":
    case "origin_not_allowed":
    case "session_unavailable":
    case "detect_only":
    case "image_disabled":
      return 403;
    case "widget_not_detected":
    case "solver_error":
    case "image_capture_failed":
      return 422;
    case "solved":
    case "injected":
    case "detected":
    default:
      return 200;
  }
};

const send = (reply: FastifyReply, result: CaptchaSolverResponseBody) =>
  reply.status(statusCodeFor(result)).send(result);

const redactUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
};

const validateSession = (
  server: FastifyInstance,
  sessionId: string | undefined,
): boolean => {
  if (!sessionId) return true;
  if (!server.cdpService.isRunning()) return false;
  return sessionId === server.sessionService.activeSession.id;
};

/**
 * Captures the live-page pixels/audio for an image/puzzle widget and folds them
 * into the descriptor before handing it to the provider. Throws on capture
 * failure (the route maps that to image_capture_failed).
 */
const captureImageWidget = async (
  page: Page,
  widget: CaptchaWidgetDescriptor,
): Promise<CaptchaWidgetDescriptor> => {
  const maxBytes = env.CAPTCHA_SOLVER_MAX_IMAGE_BYTES;
  if (widget.type === "image_audio") {
    const findings = await findImageCaptchaElements(page);
    const finding = findings.find((f) => f.type === "image_audio" && f.selector === widget.selector) ?? findings[0];
    if (!finding) throw new Error("No audio captcha element found on the page");
    const audioBase64 = await captureAudio(page, finding, maxBytes);
    return { ...widget, audioBase64 };
  }

  const findings = await findImageCaptchaElements(page);
  const finding =
    findings.find((f) => f.type === widget.type && f.selector === widget.selector) ??
    findings.find((f) => f.type === widget.type) ??
    findings[0];
  if (!finding) throw new Error("No image captcha element found on the page");
  const imageBase64 = await captureImage(page, finding, maxBytes);
  return { ...widget, imageBase64, instructions: widget.instructions ?? finding.instructions };
};

async function routes(server: FastifyInstance) {
  server.post(
    "/captcha/detect",
    {
      schema: {
        operationId: "detect_captcha_widgets",
        description:
          "Detect CAPTCHA widgets on the live session page. Disabled by default; only exact-origin allowlisted URLs are inspected.",
        tags: ["Captcha Solver"],
        summary: "Detect CAPTCHA widgets on the page",
        body: $ref("CaptchaDetectRequest"),
        response: {
          200: $ref("CaptchaSolverResponse"),
          403: $ref("CaptchaSolverResponse"),
          422: $ref("CaptchaSolverResponse"),
        },
      },
    },
    async (request: CaptchaDetectRequest, reply: FastifyReply) => {
      const { url, sessionId } = request.body;

      if (!service.isAllowed(url)) {
        return send(reply, {
          ...base(),
          status: service.isEnabled() ? "origin_not_allowed" : "disabled",
          allowedOrigin: (() => {
            try {
              return new URL(url).origin;
            } catch {
              return undefined;
            }
          })(),
          redacted: { url: redactUrl(url) },
          error: service.isEnabled()
            ? "URL origin is not exactly allowlisted for captcha solving."
            : "Captcha solver is disabled.",
        });
      }

      if (!validateSession(server, sessionId)) {
        return send(reply, {
          ...base(),
          status: "session_unavailable",
          redacted: { url: redactUrl(url) },
          error: "No live session matching the supplied sessionId.",
        });
      }

      if (!server.cdpService.isRunning()) {
        await server.cdpService.launch();
      }
      const page = await server.cdpService.getPrimaryPage();

      let widgets: CaptchaWidgetDescriptor[];
      try {
        widgets = await detectWidgets(page, url);
        // Image/puzzle widgets are detected separately when the image pipeline
        // is enabled (it has its own gate; page pixels are not inspected unless
        // the operator opted in).
        if (env.CAPTCHA_SOLVER_IMAGE_ENABLED) {
          const imageFindings = await findImageCaptchaElements(page);
          for (const finding of imageFindings) {
            widgets.push({
              type: finding.type,
              url,
              selector: finding.selector,
              instructions: finding.instructions,
            });
          }
        }
      } catch (error) {
        return send(reply, {
          ...base(),
          status: "solver_error",
          redacted: { url: redactUrl(url) },
          error: `Failed to inspect page: ${(error as Error).message}`,
        });
      }

      if (!widgets.length) {
        return send(reply, {
          ...base(),
          status: "widget_not_detected",
          redacted: { url: redactUrl(url) },
        });
      }

      return send(reply, {
        ...base(),
        status: "detected",
        redacted: { url: redactUrl(url) },
        widgets,
      });
    },
  );

  server.post(
    "/captcha/solve",
    {
      schema: {
        operationId: "solve_captcha",
        description:
          "Solve a CAPTCHA on the live session page via the configured provider and inject the token. Disabled by default; only exact-origin allowlisted URLs are accepted.",
        tags: ["Captcha Solver"],
        summary: "Solve a CAPTCHA and inject the token",
        body: $ref("CaptchaSolveRequest"),
        response: {
          200: $ref("CaptchaSolverResponse"),
          403: $ref("CaptchaSolverResponse"),
          422: $ref("CaptchaSolverResponse"),
        },
      },
    },
    async (request: CaptchaSolveRequest, reply: FastifyReply) => {
      const { url, sessionId, widget: suppliedWidget } = request.body;

      if (!service.isAllowed(url)) {
        return send(reply, {
          ...base(),
          status: service.isEnabled() ? "origin_not_allowed" : "disabled",
          redacted: { url: redactUrl(url) },
          error: service.isEnabled()
            ? "URL origin is not exactly allowlisted for captcha solving."
            : "Captcha solver is disabled.",
        });
      }

      if (!validateSession(server, sessionId)) {
        return send(reply, {
          ...base(),
          status: "session_unavailable",
          redacted: { url: redactUrl(url) },
          error: "No live session matching the supplied sessionId.",
        });
      }

      if (!server.cdpService.isRunning()) {
        await server.cdpService.launch();
      }
      const page = await server.cdpService.getPrimaryPage();

      let widget: CaptchaWidgetDescriptor | undefined = suppliedWidget;
      if (!widget) {
        try {
          const detected = await detectWidgets(page, url);
          widget = detected[0];
        } catch (error) {
          return send(reply, {
            ...base(),
            status: "solver_error",
            redacted: { url: redactUrl(url) },
            error: `Failed to inspect page: ${(error as Error).message}`,
          });
        }
      }

      if (!widget) {
        return send(reply, {
          ...base(),
          status: "widget_not_detected",
          redacted: { url: redactUrl(url) },
        });
      }

      // detect-only mode permits detection but blocks solving entirely — no
      // provider calls, no page mutation. Checked here (after widget resolution)
      // so the error carries the widget context.
      if (!service.canSolve()) {
        return send(reply, {
          ...base(),
          status: "detect_only",
          mode: service.getMode(),
          redacted: { url: redactUrl(url) },
          widget,
          error:
            "Captcha solver is in detect-only mode; /solve is blocked. Set CAPTCHA_SOLVER_MODE=auto to enable solving.",
        });
      }

      // Image/puzzle widgets have their own gate and capture step. Page pixels
      // / audio are exfiltrated to the provider, so the operator must enable
      // CAPTCHA_SOLVER_IMAGE_ENABLED in addition to the master flag.
      if (isImageType(widget.type)) {
        if (!env.CAPTCHA_SOLVER_IMAGE_ENABLED) {
          return send(reply, {
            ...base(),
            status: "image_disabled",
            redacted: { url: redactUrl(url) },
            widget,
            error:
              "Image/puzzle solving is disabled. Set CAPTCHA_SOLVER_IMAGE_ENABLED=true to enable (page pixels/audio are sent to the provider).",
          });
        }

        // Capture first — the provider needs the pixels/audio, not a sitekey.
        let capturedWidget: CaptchaWidgetDescriptor;
        try {
          capturedWidget = await captureImageWidget(page, widget);
        } catch (error) {
          return send(reply, {
            ...base(),
            status: "image_capture_failed",
            redacted: { url: redactUrl(url) },
            widget,
            error: `Failed to capture image captcha: ${(error as Error).message}`,
          });
        }
        const outcome = await service.solve(capturedWidget);
        if (outcome.status !== "solved") {
          const { status: _omitted, ...rest } = outcome;
          void _omitted;
          return send(reply, {
            ...base(),
            status: "solver_error",
            ...rest,
            widget,
          });
        }

        let injected = false;
        try {
          injected = await applyImageResult(page, capturedWidget, {
            text: outcome.text,
            coordinates: outcome.coordinates,
            angle: outcome.angle,
          });
        } catch {
          /* best-effort; result still returned */
        }

        return send(reply, {
          ...base(),
          status: "injected",
          provider: outcome.provider,
          widget,
          text: outcome.text,
          coordinates: outcome.coordinates,
          angle: outcome.angle,
          providerTaskId: outcome.providerTaskId,
          injected,
          redacted: outcome.redacted,
        });
      }

      // Token widget flow (unchanged).
      const outcome = await service.solve(widget);
      if (outcome.status !== "solved" || !outcome.token) {
        // The route already gated enabled + allowed origin above, so the only
        // realistic non-solved status here is solver_error. Drop the outcome's
        // own status and surface the canonical solver_error shape.
        const { status: _omitted, ...rest } = outcome;
        void _omitted;
        return send(reply, {
          ...base(),
          status: "solver_error",
          ...rest,
          widget,
        });
      }

      let injected = false;
      try {
        injected = await injectToken(page, widget, outcome.token);
      } catch {
        /* best-effort; token still returned */
      }

      return send(reply, {
        ...base(),
        status: "injected",
        provider: outcome.provider,
        widget,
        token: outcome.token,
        providerTaskId: outcome.providerTaskId,
        injected,
        redacted: outcome.redacted,
      });
    },
  );
}

export default routes;
