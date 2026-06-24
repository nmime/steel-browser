import { FastifyRequest } from "fastify";
import { z } from "zod";

export const ChallengeKind = z.enum(["captcha", "bot_check", "login_mfa", "rate_limit", "unknown"]);

const safeString = (max: number) => z.string().trim().max(max);

const ChallengeDetectionRequest = z
  .object({
    url: z
      .string()
      .url()
      .describe("Page URL to inspect. Only exact allowlisted origins are accepted."),
    title: safeString(512).optional().describe("Optional page title text."),
    visibleText: safeString(4096)
      .optional()
      .describe(
        "Optional visible text excerpt. Do not send page HTML, cookies, tokens, images, or audio.",
      ),
    indicators: z
      .array(safeString(256))
      .max(20)
      .optional()
      .describe("Optional caller-observed challenge indicators such as labels or element names."),
  })
  .strict();

const ChallengeReportRequest = ChallengeDetectionRequest.extend({
  kind: ChallengeKind.optional().describe("Caller-observed challenge category."),
  provider: safeString(128).optional().describe("Human-readable provider name, if visible."),
  metadata: z
    .record(z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe("Small diagnostic metadata. Sensitive keys are redacted and values are truncated."),
}).strict();

const ManualHandoffRequest = z
  .object({
    url: z.string().url().describe("Page URL requiring a human-controlled handoff."),
    reason: safeString(512).optional(),
    challengeId: safeString(128).optional(),
    expiresInSeconds: z.number().int().min(60).max(3600).optional(),
  })
  .strict();

const OwnedTestCallbackRequest = z
  .object({
    url: z
      .string()
      .url()
      .describe("Owned test page URL. Only exact allowlisted origins are accepted."),
    testId: safeString(128),
    challengeId: safeString(128).optional(),
    result: z.enum(["shown", "completed", "expired", "failed"]),
    metadata: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .strict();

const ChallengeAssistanceResponse = z.object({
  status: z.enum([
    "disabled",
    "origin_not_allowed",
    "reported",
    "detected",
    "manual_handoff_required",
    "callback_accepted",
    "callback_secret_not_configured",
    "invalid_signature",
  ]),
  assistanceEnabled: z.boolean(),
  allowedOrigin: z.string().optional(),
  reportId: z.string().optional(),
  challenge: z
    .object({
      suspected: z.boolean(),
      kind: ChallengeKind,
      provider: z.string().optional(),
      indicators: z.array(z.string()).optional(),
    })
    .optional(),
  redacted: z
    .object({
      url: z.string(),
      title: z.string().optional(),
      visibleText: z.string().optional(),
      metadata: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    })
    .optional(),
  manualHandoff: z
    .object({
      challengeId: z.string(),
      message: z.string(),
      expiresAt: z.string().datetime().optional(),
    })
    .optional(),
  safeHandling: z.array(z.string()),
  error: z.string().optional(),
});

export type ChallengeDetectionBody = z.infer<typeof ChallengeDetectionRequest>;
export type ChallengeDetectionRequest = FastifyRequest<{ Body: ChallengeDetectionBody }>;

export type ChallengeReportBody = z.infer<typeof ChallengeReportRequest>;
export type ChallengeReportRequest = FastifyRequest<{ Body: ChallengeReportBody }>;

export type ManualHandoffBody = z.infer<typeof ManualHandoffRequest>;
export type ManualHandoffRequest = FastifyRequest<{ Body: ManualHandoffBody }>;

export type OwnedTestCallbackBody = z.infer<typeof OwnedTestCallbackRequest>;
export type OwnedTestCallbackRequest = FastifyRequest<{ Body: OwnedTestCallbackBody }>;

export type ChallengeAssistanceResponse = z.infer<typeof ChallengeAssistanceResponse>;

export const challengeSchemas = {
  ChallengeDetectionRequest,
  ChallengeReportRequest,
  ManualHandoffRequest,
  OwnedTestCallbackRequest,
  ChallengeAssistanceResponse,
};

export default challengeSchemas;
