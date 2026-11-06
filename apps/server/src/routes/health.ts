import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";

export interface HealthRouteOptions {
  db: Db;
}

/** Spec §14: liveness plus a cheap database probe. */
export async function healthRoutes(
  app: FastifyInstance,
  opts: HealthRouteOptions,
): Promise<void> {
  app.get("/api/health", async () => {
    let db: "ok" | "error" = "ok";
    try {
      opts.db.get(sql`select 1`);
    } catch {
      db = "error";
    }
    return {
      ok: true,
      db,
      version: "0.1.0",
      uptime: process.uptime(),
    };
  });
}
