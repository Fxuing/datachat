import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/test/**/*.test.ts", "packages/**/test/**/*.test.ts"],
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
