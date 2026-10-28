import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Server configuration from environment variables.
 * The API key value itself is never logged, returned by /api/health,
 * or included in any response. It is read only inside the live path.
 */
export function getConfig(env = process.env) {
  const port = Number.parseInt(env.PORT ?? "8787", 10);
  return {
    host: "127.0.0.1",
    port: Number.isInteger(port) && port > 0 ? port : 8787,
    modelApiKeyConfigured: Boolean(env.MODEL_API_KEY && env.MODEL_API_KEY.trim()),
    liveMetaEnabled: env.ENABLE_LIVE_META === "1",
    liveTestTokenConfigured: Boolean(env.LIVE_TEST_TOKEN && env.LIVE_TEST_TOKEN.trim()),
  };
}

/** Read the key only when a gated live request actually needs it. */
export function getModelApiKey(env = process.env) {
  return typeof env.MODEL_API_KEY === "string" ? env.MODEL_API_KEY.trim() : "";
}

export function getLiveTestToken(env = process.env) {
  return typeof env.LIVE_TEST_TOKEN === "string" ? env.LIVE_TEST_TOKEN.trim() : "";
}

/**
 * Load the project-root .env when the server is started intentionally.
 * Does nothing when the file is absent. Values are never printed.
 */
export function loadRootEnv(env = process.env) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return false;
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envPath);
    void env;
    return true;
  }
  return false;
}
