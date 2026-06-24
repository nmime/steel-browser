import { z } from "zod";
import { config } from "dotenv";

config();

const booleanString = (defaultValue: "true" | "false" = "false") =>
  z
    .string()
    .optional()
    .transform((val) => val === "true" || val === "1")
    .default(defaultValue);

const integerString = (defaultValue: string) =>
  z
    .string()
    .optional()
    .transform((val) => {
      const parsed = Number.parseInt(val ?? defaultValue, 10);
      return Number.isFinite(parsed) ? parsed : Number.parseInt(defaultValue, 10);
    })
    .default(defaultValue);

const optionalPositiveInteger = () =>
  z
    .string()
    .optional()
    .transform((val) => {
      if (!val) return undefined;
      const parsed = Number.parseInt(val, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    });

const envSchema = z.object({
  NODE_ENV: z
    .enum(["test", "development", "staging", "production", "preview"])
    .default("development"),
  HOST: z.string().optional().default("0.0.0.0"),
  DOMAIN: z.string().optional(),
  PORT: z.string().optional().default("3000"),
  USE_SSL: booleanString(),
  CDP_REDIRECT_PORT: z.string().optional().default("9222"),
  CDP_DOMAIN: z.string().optional(),
  PROXY_URL: z.string().optional(),
  PROXY_USERNAME: z.string().optional(),
  PROXY_PASSWORD: z.string().optional(),
  PROXY_BYPASS: z.string().optional(),
  DEFAULT_HEADERS: z
    .string()
    .optional()
    .transform((val) => (val ? JSON.parse(val) : {}))
    .pipe(z.record(z.string()).optional().default({})),
  KILL_TIMEOUT: z.string().optional().default("0"),
  CHROME_EXECUTABLE_PATH: z.string().optional(),
  CHROME_HEADLESS: booleanString("true"),
  DISPLAY: z.string().optional().default(":10"),
  ENABLE_CDP_LOGGING: booleanString(),
  LOG_CUSTOM_EMIT_EVENTS: booleanString(),
  ENABLE_VERBOSE_LOGGING: booleanString(),
  DEFAULT_TIMEZONE: z.string().optional(),
  TIMEZONE_SERVICE_URL: z.string().optional(),
  SKIP_FINGERPRINT_INJECTION: booleanString(),
  CHROME_ARGS: z
    .string()
    .optional()
    .transform((val) => (val ? val.split(" ").map((arg) => arg.trim()) : []))
    .default(""),
  FILTER_CHROME_ARGS: z
    .string()
    .optional()
    .transform((val) => (val ? val.split(" ").map((arg) => arg.trim()) : []))
    .default(""),
  DEBUG_CHROME_PROCESS: booleanString(),
  PROXY_INTERNAL_BYPASS: z.string().optional(),
  CHROME_USER_DATA_DIR: z.string().optional(),
  LOG_STORAGE_ENABLED: booleanString(),
  LOG_STORAGE_PATH: z.string().optional(),
  DISABLE_CHROME_SANDBOX: booleanString(),
  STEEL_AUTH_ENABLED: booleanString(),
  STEEL_AUTH_JWT_SECRET: z.string().optional(),
  STEEL_AUTH_JWT_TTL_SECONDS: z
    .string()
    .optional()
    .transform((val) => {
      const parsed = Number.parseInt(val ?? "3600", 10);
      return Number.isFinite(parsed) ? parsed : 3600;
    })
    .default("3600"),
  STEEL_AUTH_USERS: z.string().optional(),
  STEEL_AUTH_LOCAL_ADMIN_EMAIL: z.string().optional(),
  STEEL_AUTH_LOCAL_ADMIN_PASSWORD: z.string().optional(),
  STEEL_AUTH_STORE_PATH: z.string().optional(),
  STEEL_API_KEY: z.string().optional(),
  STEEL_API_KEYS: z.string().optional(),
  STEEL_DEFAULT_TENANT_ID: z.string().optional().default("default"),
  STEEL_CORS_ALLOWED_ORIGINS: z.string().optional().default(""),
  STEEL_CONTROL_PLANE_ENABLED: booleanString(),
  STEEL_CONTROL_PLANE_PATH: z.string().optional().default("/v1/control-plane"),
  STEEL_WORKER_ENABLED: booleanString(),
  STEEL_ROLE: z.enum(["standalone", "scheduler", "worker"]).default("standalone"),
  SCHEDULER_URL: z.string().optional(),
  WORKER_PUBLIC_URL: z.string().optional(),
  WORKER_MAX_SESSIONS: integerString("1"),
  WORKER_IDLE_BROWSER: booleanString("true"),
  WORKER_HEARTBEAT_INTERVAL_MS: integerString("5000"),
  WORKER_STALE_AFTER_MS: integerString("30000"),
  WORKER_DRAIN_TIMEOUT_MS: integerString("30000"),
  STEEL_SESSION_RECOVERY_ENABLED: booleanString(),
  STEEL_SESSION_RECOVERY_AUTO_ALLOCATE: booleanString(),
  STEEL_SESSION_RECOVERY_MAX_ATTEMPTS: integerString("1"),
  STEEL_SESSION_RECOVERY_SWEEP_INTERVAL_MS: integerString("5000"),
  STEEL_REMOTE_STORAGE_ENABLED: booleanString(),
  STEEL_METADATA_STORE_PATH: z.string().optional(),
  STEEL_SESSIONS_STORE_PATH: z.string().optional(),
  STEEL_WORKER_REGISTRY_STORE_PATH: z.string().optional(),
  STEEL_PROXY_STORE_PATH: z.string().optional(),
  STEEL_FILE_METADATA_STORE_PATH: z.string().optional(),
  STEEL_EXTENSIONS_STORE_PATH: z.string().optional(),
  STEEL_TRACE_ARTIFACTS_STORE_PATH: z.string().optional(),
  STEEL_FILE_STORAGE_PROVIDER: z.enum(["local"]).optional().default("local"),
  STEEL_LOCAL_FILE_STORAGE_PATH: z.string().optional(),
  STEEL_FILE_STORAGE_MAX_BYTES_PER_SESSION: optionalPositiveInteger(),
  STEEL_FILE_STORAGE_MAX_BYTES_PER_FILE: optionalPositiveInteger(),
  STEEL_CHALLENGE_DETECTION_ENABLED: booleanString(),
  STEEL_PROXY_MANAGEMENT_ENABLED: booleanString(),
  STEEL_VAULT_MASTER_KEY: z.string().optional(),
  STEEL_VAULT_MASTER_KEY_FILE: z.string().optional(),
  STEEL_VAULT_STORE_PATH: z.string().optional(),
  STEEL_PROFILES_STORE_PATH: z.string().optional(),
  STEEL_EXTENSIONS_REGISTRY_ENABLED: booleanString(),
  STEEL_EXTENSIONS_DIR: z.string().optional().default(""),
  STEEL_TRACE_ARTIFACTS_ENABLED: booleanString(),
  STEEL_TRACE_ARTIFACTS_DIR: z.string().optional().default("./trace-artifacts"),
  STEEL_TRACE_ARTIFACTS_MAX_BYTES: integerString("104857600"),
  STEEL_TRACE_ARTIFACTS_MAX_EVENTS: integerString("10000"),
  STEEL_TRACE_ARTIFACTS_PREFIX: z.string().optional().default("telemetry/artifacts"),
  CHALLENGE_ASSISTANCE_ENABLED: booleanString(),
  CHALLENGE_ASSISTANCE_ALLOWED_ORIGINS: z.string().optional().default(""),
  CHALLENGE_OWNED_TEST_CALLBACK_SECRET: z.string().optional(),
  CHALLENGE_OWNED_TEST_CALLBACK_MAX_SKEW_MS: z
    .string()
    .optional()
    .transform((val) => {
      const parsed = Number.parseInt(val ?? "300000", 10);
      return Number.isFinite(parsed) ? parsed : 300000;
    })
    .default("300000"),
});

export const env = envSchema.parse(process.env);
