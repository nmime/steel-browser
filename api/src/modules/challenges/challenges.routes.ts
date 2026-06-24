import { FastifyInstance, FastifyReply } from "fastify";
import { env } from "../../env.js";
import { $ref } from "../../plugins/schemas.js";
import { createChallengeAssistanceService } from "../../services/challenges/challenge-assistance.service.js";
import type {
  ChallengeDetectionRequest,
  ChallengeReportRequest,
  ManualHandoffRequest,
  OwnedTestCallbackRequest,
  ChallengeAssistanceResponse,
} from "./challenges.schema.js";

const service = createChallengeAssistanceService({
  enabled: env.CHALLENGE_ASSISTANCE_ENABLED,
  allowedOrigins: env.CHALLENGE_ASSISTANCE_ALLOWED_ORIGINS,
  ownedTestCallbackSecret: env.CHALLENGE_OWNED_TEST_CALLBACK_SECRET,
  ownedTestCallbackMaxSkewMs: env.CHALLENGE_OWNED_TEST_CALLBACK_MAX_SKEW_MS,
});

const statusCodeFor = (result: ChallengeAssistanceResponse): number => {
  switch (result.status) {
    case "disabled":
    case "origin_not_allowed":
    case "callback_secret_not_configured":
      return 403;
    case "invalid_signature":
      return 401;
    case "callback_accepted":
      return 202;
    default:
      return 200;
  }
};

const send = (reply: FastifyReply, result: ChallengeAssistanceResponse) =>
  reply.status(statusCodeFor(result)).send(result);

async function routes(server: FastifyInstance) {
  server.post(
    "/challenge-assistance/detect",
    {
      schema: {
        operationId: "detect_challenge_assistance",
        description:
          "Disabled-by-default, exact-origin challenge detection skeleton. Redacts diagnostics and does not automate challenge completion.",
        tags: ["Challenge Assistance"],
        summary: "Detect challenge indicators without solving",
        body: $ref("ChallengeDetectionRequest"),
        response: {
          200: $ref("ChallengeAssistanceResponse"),
          403: $ref("ChallengeAssistanceResponse"),
        },
      },
    },
    async (request: ChallengeDetectionRequest, reply: FastifyReply) =>
      send(reply, service.detectChallenge(request.body)),
  );

  server.post(
    "/challenge-assistance/report",
    {
      schema: {
        operationId: "report_challenge_assistance",
        description:
          "Report redacted challenge diagnostics for an exact allowlisted origin. Does not accept cookies, page HTML, images, audio, or challenge tokens.",
        tags: ["Challenge Assistance"],
        summary: "Report redacted challenge diagnostics",
        body: $ref("ChallengeReportRequest"),
        response: {
          200: $ref("ChallengeAssistanceResponse"),
          403: $ref("ChallengeAssistanceResponse"),
        },
      },
    },
    async (request: ChallengeReportRequest, reply: FastifyReply) =>
      send(reply, service.reportChallenge(request.body)),
  );

  server.post(
    "/challenge-assistance/manual-handoff",
    {
      schema: {
        operationId: "request_challenge_manual_handoff",
        description:
          "Request human manual handoff for an exact allowlisted origin. The API only returns instructions and never completes challenges automatically.",
        tags: ["Challenge Assistance"],
        summary: "Request manual challenge handoff",
        body: $ref("ManualHandoffRequest"),
        response: {
          200: $ref("ChallengeAssistanceResponse"),
          403: $ref("ChallengeAssistanceResponse"),
        },
      },
    },
    async (request: ManualHandoffRequest, reply: FastifyReply) =>
      send(reply, service.requestManualHandoff(request.body)),
  );

  server.post(
    "/challenge-assistance/owned-test-callback",
    {
      schema: {
        operationId: "owned_test_challenge_callback",
        description:
          "HMAC-protected callback for owned test pages only. It records redacted callback status and does not submit challenge responses.",
        tags: ["Challenge Assistance"],
        summary: "Receive owned-test challenge callback",
        body: $ref("OwnedTestCallbackRequest"),
        response: {
          202: $ref("ChallengeAssistanceResponse"),
          401: $ref("ChallengeAssistanceResponse"),
          403: $ref("ChallengeAssistanceResponse"),
        },
      },
    },
    async (request: OwnedTestCallbackRequest, reply: FastifyReply) => {
      const timestamp = request.headers["x-steel-challenge-timestamp"];
      const signature = request.headers["x-steel-challenge-signature"];
      const result = service.handleOwnedTestCallback(
        request.body,
        JSON.stringify(request.body ?? {}),
        Array.isArray(timestamp) ? timestamp[0] : timestamp,
        Array.isArray(signature) ? signature[0] : signature,
      );
      return send(reply, result);
    },
  );
}

export default routes;
