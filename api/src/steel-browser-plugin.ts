import fastifyView from "@fastify/view";
import { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import path, { dirname } from "node:path";
import browserInstancePlugin from "./plugins/browser.js";
import browserSessionPlugin from "./plugins/browser-session.js";
import workerRuntimePlugin from "./plugins/worker-runtime.js";
import schedulerRuntimePlugin from "./plugins/scheduler-runtime.js";
import schedulerRoutingPlugin from "./plugins/scheduler-routing.js";
import workerHeartbeatPlugin from "./plugins/worker-heartbeat.js";
import browserWebSocket from "./plugins/browser-socket/browser-socket.js";
import customBodyParser from "./plugins/custom-body-parser.js";
import fileStoragePlugin from "./plugins/file-storage.js";
import requestLogger from "./plugins/request-logger.js";
import authPlugin from "./modules/auth/auth.plugin.js";
import openAPIPlugin from "./plugins/schemas.js";
import seleniumPlugin from "./plugins/selenium.js";
import {
  actionsRoutes,
  authRoutes,
  challengesRoutes,
  cdpRoutes,
  filesRoutes,
  extensionRoutes,
  telemetryRoutes,
  logsRoutes,
  profilesRoutes,
  proxiesRoutes,
  schedulerRoutes,
  seleniumRoutes,
  sessionsRoutes,
  vaultRoutes,
  workerRoutes,
} from "./routes.js";
import { fileURLToPath } from "node:url";
import ejs from "ejs";
import type { CDPService } from "./services/cdp/cdp.service.js";
import type { BrowserLauncherOptions } from "./types/browser.js";
import { WebSocketHandler } from "./types/websocket.js";
import { WebSocketRegistryService } from "./services/websocket-registry.service.js";
import { SessionService } from "./services/session.service.js";
import { WorkerRuntimeService } from "./services/workers/worker-runtime.service.js";
import { LogStorage } from "./services/cdp/instrumentation/storage/log-storage.interface.js";
import { env } from "./env.js";
import controlPlaneRoutes from "./modules/control-plane/control-plane.routes.js";

// We need to redeclare any decorators from within the plugin that we want to expose
declare module "fastify" {
  interface FastifyInstance {
    steelBrowserConfig: SteelBrowserConfig;
    cdpService: CDPService;
    sessionService: SessionService;
    workerRuntime: WorkerRuntimeService;
    webSocketRegistry: WebSocketRegistryService;
    registerCDPLaunchHook: (hook: (config: BrowserLauncherOptions) => Promise<void> | void) => void;
    registerCDPShutdownHook: (
      hook: (config: BrowserLauncherOptions | null) => Promise<void> | void,
    ) => void;
  }

  interface LogStorageInterface extends LogStorage {}
}

export interface SteelBrowserConfig {
  fileStorage?: {
    provider?: "local";
    localBasePath?: string;
    maxSizePerSession?: number;
    maxSizePerFile?: number;
    metadataStorePath?: string;
  };
  customWsHandlers?: WebSocketHandler[];
  logging?: {
    enableStorage?: boolean;
    storagePath?: string;
    enableConsoleLogging?: boolean;
    enableLogsRoutes?: boolean;
  };
}

const steelBrowserPlugin: FastifyPluginAsync<SteelBrowserConfig> = async (fastify, opts) => {
  fastify.decorate("steelBrowserConfig", opts);
  // Plugins
  await fastify.register(fastifyView, {
    engine: {
      ejs,
    },
    root: path.join(dirname(fileURLToPath(import.meta.url)), "templates"),
  });
  await fastify.register(authPlugin);
  await fastify.register(requestLogger);
  await fastify.register(openAPIPlugin);
  await fastify.register(fileStoragePlugin);
  await fastify.register(browserInstancePlugin);
  await fastify.register(seleniumPlugin);
  await fastify.register(browserWebSocket, {
    customHandlers: opts.customWsHandlers,
  });
  await fastify.register(customBodyParser);
  await fastify.register(workerRuntimePlugin);
  await fastify.register(schedulerRuntimePlugin);
  await fastify.register(browserSessionPlugin);
  await fastify.register(workerHeartbeatPlugin);
  await fastify.register(schedulerRoutingPlugin);

  // Routes
  await fastify.register(authRoutes, { prefix: "/v1" });
  await fastify.register(actionsRoutes, { prefix: "/v1" });
  await fastify.register(challengesRoutes, { prefix: "/v1" });
  await fastify.register(sessionsRoutes, { prefix: "/v1" });
  await fastify.register(vaultRoutes, { prefix: "/v1" });
  await fastify.register(profilesRoutes, { prefix: "/v1" });
  await fastify.register(proxiesRoutes, { prefix: "/v1" });
  await fastify.register(cdpRoutes, { prefix: "/v1" });
  await fastify.register(seleniumRoutes);
  await fastify.register(filesRoutes, { prefix: "/v1" });
  await fastify.register(extensionRoutes, { prefix: "/v1" });
  await fastify.register(telemetryRoutes, { prefix: "/v1" });

  if (env.STEEL_ROLE === "worker") {
    await fastify.register(workerRoutes, { prefix: "/v1/internal/worker" });
  }

  if (env.STEEL_ROLE === "scheduler") {
    await fastify.register(schedulerRoutes, { prefix: "/v1/scheduler" });
  }

  const enableLogsRoutes = opts.logging?.enableLogsRoutes ?? true;
  if (enableLogsRoutes) {
    await fastify.register(logsRoutes, { prefix: "/v1/logs" });
  }

  if (env.STEEL_CONTROL_PLANE_ENABLED) {
    await fastify.register(controlPlaneRoutes, { prefix: env.STEEL_CONTROL_PLANE_PATH });
  }
};

export default fp<SteelBrowserConfig>(steelBrowserPlugin, {
  name: "steel-browser",
  fastify: "5.x",
});
