import { spawnSync } from "node:child_process";

const env = { ...process.env, REDOCLY_TELEMETRY: "off" };

for (const key of Object.keys(env)) {
  const lower = key.toLowerCase();
  if (
    lower === "npm_config_verify_deps_before_run" ||
    lower === "npm_config_npm_globalconfig" ||
    lower === "npm_config__jsr_registry" ||
    lower === "npm_config_network_concurrency"
  ) {
    delete env[key];
  }
}

const result = spawnSync("npm", ["exec", "--yes", "--package", "@redocly/cli@2.31.1", "--", "redocly", "lint", "openapi/openapi.json"], {
  stdio: "inherit",
  env
});

process.exit(result.status ?? 1);
