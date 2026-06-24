/**
 * Shared base for providers that follow the anti-captcha-style JSON API:
 *   POST {endpoint}/createTask   { clientKey, task }
 *   POST {endpoint}/getTaskResult { clientKey, taskId }   (poll until status === "ready")
 *
 * 2Captcha, CapSolver, Anti-Captcha and CapMonster all conform to this shape;
 * they differ only in their endpoint and their task-type naming, which concrete
 * subclasses supply. Uses global `fetch` by default so tests can stub it.
 */
import type {
  CaptchaSolverProvider,
  CaptchaSolverProviderType,
  CaptchaWidgetDescriptor,
  CaptchaWidgetType,
  SolveOptions,
  SolveRequest,
  SolveResult,
} from "./captcha-provider.js";
import {
  CaptchaSolverError,
  CaptchaSolverRejectedError,
  CaptchaSolverTimeoutError,
  CaptchaUnsupportedWidgetError,
  isImageType,
} from "./captcha-provider.js";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

interface ProviderResponse {
  errorId?: number;
  errorCode?: string;
  errorDescription?: string;
  status?: string;
  taskId?: number | string;
  cost?: number;
  solution?: unknown;
}

export abstract class BaseSolverProvider implements CaptchaSolverProvider {
  abstract readonly type: CaptchaSolverProviderType;
  abstract readonly supportedTypes: ReadonlyArray<CaptchaWidgetType>;
  protected abstract readonly endpoint: string;

  constructor(protected readonly apiKey: string) {
    if (!apiKey) {
      throw new CaptchaSolverError(
        `Missing API key for solver provider`,
        500,
        "missing_api_key",
      );
    }
  }

  /**
   * Returns this provider's task-type string for a widget type, or `undefined`
   * when this provider does not support that type. The base solve() loop turns
   * an `undefined` return into a typed `CaptchaUnsupportedWidgetError`, so each
   * provider can declare exactly the types it supports without breaking the
   * compile-time exhaustiveness check on the cases it does handle.
   */
  protected abstract taskTypeFor(type: CaptchaWidgetType): string | undefined;

  /**
   * Builds the `task` object sent to createTask. The base implementation
   * covers the common cases — token widgets keyed on sitekey, the GeeTest and
   * Arkose parameter shapes, and the image/puzzle `body` shape. Subclasses may
   * override to add provider-specific fields or naming.
   */
  protected buildTask(request: SolveRequest, taskType: string): Record<string, unknown> {
    const widget = request.widget;
    const task: Record<string, unknown> = { type: taskType };
    if (request.userAgent) task.userAgent = request.userAgent;

    // Image / puzzle widgets: the payload is the captured image/audio, not a
    // sitekey. The provider API names vary; `body` (anti-captcha/2captcha) and
    // `img` are both accepted as aliases by these providers.
    if (isImageType(widget.type)) {
      return this.buildImageTask(task, widget);
    }

    switch (widget.type) {
      case "geetest":
        task.websiteURL = widget.url;
        task.gt = widget.gt ?? "";
        task.challenge = widget.challenge ?? "";
        if (widget.serviceUrl) task.geetestApiServerSubdomain = widget.serviceUrl;
        return task;
      case "geetest_v4":
        task.websiteURL = widget.url;
        task.captchaId = widget.captchaId ?? "";
        if (widget.serviceUrl) task.geetestApiServerSubdomain = widget.serviceUrl;
        return task;
      case "funcaptcha":
        task.websiteURL = widget.url;
        task.websitePublicKey = widget.publicKey ?? "";
        if (widget.serviceUrl) task.funcaptchaApiJSSubdomain = widget.serviceUrl;
        if (widget.blob) task.data = { blob: widget.blob };
        return task;
      case "amazon_waf":
        task.websiteURL = widget.url;
        task.websiteKey = widget.sitekey ?? "";
        if (widget.blob) task.uxd = widget.blob;
        if (widget.serviceUrl) task.context = widget.serviceUrl;
        return task;
      default:
        // All remaining token widgets are sitekey + URL.
        task.websiteURL = widget.url;
        task.websiteKey = widget.sitekey ?? widget.taskId ?? "";
        if (widget.type === "recaptcha_v3") task.pageAction = widget.action ?? "";
        return task;
    }
  }

  /**
   * Builds the image/puzzle task payload. `image_text` and `image_canvas` send
   * a single image; `image_grid` sends a tile array; `image_audio` sends audio.
   * Coordinates/rotate/click widgets reuse the single-image shape and differ
   * only in their task type.
   */
  protected buildImageTask(
    task: Record<string, unknown>,
    widget: CaptchaWidgetDescriptor,
  ): Record<string, unknown> {
    if (widget.type === "image_grid" && widget.imageGrid?.length) {
      task.body = widget.imageGrid;
      task.rows = widget.rows ?? 0;
      task.columns = widget.cols ?? 0;
    } else if (widget.type === "image_audio") {
      task.body = widget.audioBase64 ?? "";
      task.lang = widget.audioLang ?? "en";
    } else {
      task.body = widget.imageBase64 ?? "";
    }
    if (widget.instructions) task.comment = widget.instructions;
    return task;
  }

  /**
   * Pulls the token (or text) out of the provider's `solution` object. The
   * candidate list covers the field names used across the anti-captcha-style
   * providers for token widgets; GeeTest uses `seccode`/`validate`. Image
   * widgets are handled separately via `extractSolution`.
   */
  protected extractToken(solution: unknown, type: CaptchaWidgetType): string {
    if (!solution || typeof solution !== "object") return "";
    const s = solution as Record<string, unknown>;
    const candidates = [
      s.gRecaptchaResponse,
      s.token,
      s.responseText,
      s.respKey,
      s.seccode,
      s.validate,
      s.userAgent,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
    // GeeTest bundles seccode/validate inside a nested object on some providers.
    void type;
    return "";
  }

  /**
   * Extracts the full solution payload for image/puzzle widgets: returned text,
   * click coordinates, and rotation angle. Returns `null` when nothing usable
   * came back so the solve loop can reject with `empty_token` / `empty_solution`.
   */
  protected extractSolution(
    solution: unknown,
    type: CaptchaWidgetType,
  ): { text?: string; coordinates?: Array<{ x: number; y: number }>; angle?: number } | null {
    if (!solution || typeof solution !== "object") return null;
    const s = solution as Record<string, unknown>;
    const text = typeof s.text === "string" && s.text.trim() ? s.text.trim() : undefined;

    const coordsRaw = s.coordinates ?? s.coords ?? s.selectedTiles;
    let coordinates: Array<{ x: number; y: number }> | undefined;
    if (Array.isArray(coordsRaw)) {
      const parsed = coordsRaw
        .map((c) => {
          if (!c || typeof c !== "object") return null;
          const o = c as Record<string, unknown>;
          const x = Number(o.x ?? o.left);
          const y = Number(o.y ?? o.top);
          return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
        })
        .filter((c): c is { x: number; y: number } => c !== null);
      if (parsed.length) coordinates = parsed;
    }

    const angleRaw = Number(s.angle ?? s.rotate ?? s.degrees);
    const angle = Number.isFinite(angleRaw) ? angleRaw : undefined;

    if (!text && !coordinates && angle === undefined) {
      // Some providers return the text directly under `answer`.
      if (typeof s.answer === "string" && s.answer.trim()) {
        return { text: s.answer.trim() };
      }
      return null;
    }
    void type;
    return { text, coordinates, angle };
  }

  async solve(
    request: SolveRequest,
    options: SolveOptions = { timeoutMs: 180_000, pollIntervalMs: 5_000 },
  ): Promise<SolveResult> {
    const httpClient = options.fetch ?? fetch;
    const timeoutMs = options.timeoutMs ?? 180_000;
    const pollIntervalMs = options.pollIntervalMs ?? 5_000;
    const startedAt = Date.now();

    if (!this.supportedTypes.includes(request.widget.type)) {
      throw new CaptchaUnsupportedWidgetError(this.type, request.widget.type);
    }

    const taskType = this.taskTypeFor(request.widget.type);
    if (!taskType) {
      throw new CaptchaUnsupportedWidgetError(this.type, request.widget.type);
    }
    const task = this.buildTask(request, taskType);

    const created = await this.post(httpClient, "createTask", {
      clientKey: this.apiKey,
      task,
    });

    if (created.errorId && created.errorId !== 0) {
      throw new CaptchaSolverRejectedError(
        this.describeError(created) ?? `${this.type} rejected createTask`,
        created.errorCode,
      );
    }

    const taskId = created.taskId;
    if (taskId === undefined || taskId === null || taskId === "") {
      throw new CaptchaSolverRejectedError(
        `${this.type} returned no taskId`,
        "missing_task_id",
      );
    }

    const deadline = startedAt + timeoutMs;
    for (;;) {
      await sleep(pollIntervalMs);

      const result = await this.post(httpClient, "getTaskResult", {
        clientKey: this.apiKey,
        taskId,
      });

      if (result.errorId && result.errorId !== 0) {
        throw new CaptchaSolverRejectedError(
          this.describeError(result) ?? `${this.type} rejected getTaskResult`,
          result.errorCode,
        );
      }

      if (result.status === "ready") {
        const base = {
          providerTaskId: String(taskId),
          costUsd: typeof result.cost === "number" ? result.cost : undefined,
          durationMs: Date.now() - startedAt,
        };

        // Image / puzzle widgets return text/coordinates, not a token.
        if (isImageType(request.widget.type)) {
          const solution = this.extractSolution(result.solution, request.widget.type);
          if (!solution) {
            throw new CaptchaSolverRejectedError(
              `${this.type} returned an empty solution`,
              "empty_solution",
            );
          }
          return { ...base, ...solution };
        }

        const token = this.extractToken(result.solution, request.widget.type);
        if (!token) {
          throw new CaptchaSolverRejectedError(
            `${this.type} returned an empty token`,
            "empty_token",
          );
        }
        return { ...base, token };
      }

      if (Date.now() >= deadline) {
        throw new CaptchaSolverTimeoutError(String(taskId), timeoutMs);
      }
    }
  }

  protected async post(
    httpClient: typeof fetch,
    method: string,
    body: unknown,
  ): Promise<ProviderResponse> {
    let response: Response;
    try {
      response = await httpClient(`${this.endpoint}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new CaptchaSolverError(
        `${this.type} ${method} request failed: ${(error as Error).message}`,
        502,
        "request_failed",
      );
    }

    if (!response.ok) {
      throw new CaptchaSolverError(
        `${this.type} ${method} returned HTTP ${response.status}`,
        response.status,
        `http_${response.status}`,
      );
    }

    try {
      return (await response.json()) as ProviderResponse;
    } catch (error) {
      throw new CaptchaSolverError(
        `${this.type} ${method} returned invalid JSON: ${(error as Error).message}`,
        502,
        "invalid_json",
      );
    }
  }

  private describeError(res: ProviderResponse): string | undefined {
    return [res.errorDescription, res.errorCode].filter(Boolean).join(" — ") || undefined;
  }
}
