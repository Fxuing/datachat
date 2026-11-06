import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  const startedAt = Date.now();

  app.get("/api/health", async () => ({
    ok: true,
    version: "0.1.0",
    uptime: Math.floor((Date.now() - startedAt) / 1000),
  }));
}
