import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const rootDir = path.resolve(__dirname, "../..");

function readPort(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} 必须是 1-65535 之间的整数，当前值：${value}`);
  }
  return port;
}

export default defineConfig(({ mode }) => {
  // Load the repo-root .env so PORT / WEB_PORT can be set in one place.
  const env = loadEnv(mode, rootDir, "");
  const webPort = readPort(env.WEB_PORT, 5173, "WEB_PORT");
  const serverPort = readPort(env.PORT, 8080, "PORT");

  return {
    envDir: rootDir,
    plugins: [react()],
    resolve: {
      alias: { "@datachat/shared": path.resolve(rootDir, "packages/shared/src/index.ts") },
    },
    server: {
      port: webPort,
      proxy: {
        "/api": `http://localhost:${serverPort}`,
      },
    },
    preview: {
      port: webPort,
    },
  };
});
