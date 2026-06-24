import fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifySensible from "@fastify/sensible";
import steelBrowserPlugin from "./steel-browser-plugin.js";
import uiPlugin from "./plugins/ui-plugin.js";
import { loggingConfig } from "./config.js";
import { MB } from "./utils/size.js";
import path from "node:path";
import { env } from "./env.js";

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

export const server = fastify({
  logger: loggingConfig[process.env.NODE_ENV ?? "development"] ?? true,
  trustProxy: true,
  bodyLimit: 100 * MB,
  disableRequestLogging: true,
});

const setupServer = async () => {
  await server.register(fastifySensible);
  await server.register(fastifyCors, { origin: buildCorsOriginOption() as any });

  // Register UI plugin only in production (when we have built UI files)
  if (process.env.NODE_ENV === "production") {
    await server.register(uiPlugin, {
      uiDistPath: path.join(process.cwd(), "ui/dist"),
      uiPrefix: "/ui",
    });
  }

  await server.register(steelBrowserPlugin, {
    fileStorage: {
      provider: env.STEEL_FILE_STORAGE_PROVIDER,
      localBasePath: env.STEEL_LOCAL_FILE_STORAGE_PATH,
      maxSizePerSession: env.STEEL_FILE_STORAGE_MAX_BYTES_PER_SESSION ?? 100 * MB,
      maxSizePerFile: env.STEEL_FILE_STORAGE_MAX_BYTES_PER_FILE,
      metadataStorePath: env.STEEL_FILE_METADATA_STORE_PATH,
    },
  });
};

const startServer = async () => {
  try {
    await setupServer();
    await server.listen({ port: PORT, host: HOST });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

startServer();

function buildCorsOriginOption() {
  const allowedOrigins = parseCorsAllowedOrigins(env.STEEL_CORS_ALLOWED_ORIGINS);
  if (allowedOrigins.length === 0) return true;
  if (allowedOrigins.includes("*")) return true;
  return (
    origin: string | undefined,
    callback: (error: Error | null, allowed?: boolean) => void,
  ) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed by STEEL_CORS_ALLOWED_ORIGINS"), false);
  };
}

function parseCorsAllowedOrigins(value = ""): string[] {
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}
