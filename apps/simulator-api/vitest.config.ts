import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["development", "node", "import"]
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"]
  }
});
