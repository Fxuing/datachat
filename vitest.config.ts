import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@datachat/datasource-sdk": path.resolve("packages/datasource-sdk/src/index.ts"),
      "@datachat/shared": path.resolve("packages/shared/src/index.ts"),
    },
  },
  test: {
    include: ["apps/*/test/**/*.test.ts", "packages/**/test/**/*.test.ts"],
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
