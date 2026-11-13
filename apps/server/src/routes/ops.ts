import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { listBackups } from "../services/ops-backup.js";
import { getOpsMetrics } from "../services/ops-metrics.js";
import type { RetentionService, OpsError } from "../services/ops-retention.js";

interface OpsRoutesOptions {
  db: Db;
  dataDir: string;
  retention: RetentionService;
}

function errorPayload(error: unknown): { statusCode: number; body: { error: { code: string; message: string } } } | null {
  if (error instanceof Error && "code" in error && "statusCode" in error) {
    const opsError = error as OpsError;
    return {
      statusCode: opsError.statusCode,
      body: { error: { code: opsError.code, message: opsError.message } },
    };
  }
  return null;
}

export async function opsRoutes(app: FastifyInstance, opts: OpsRoutesOptions): Promise<void> {
  app.get(
    "/api/admin/ops/retention",
    { preHandler: app.requirePermission("admin.ops") },
    async () => opts.retention.preview(),
  );

  app.get(
    "/api/admin/ops/backups",
    { preHandler: app.requirePermission("admin.ops") },
    async () => listBackups(opts.dataDir),
  );

  app.get(
    "/api/admin/ops/metrics",
    {
      preHandler: app.requirePermission("admin.ops"),
      schema: {
        querystring: {
          type: "object",
          properties: { days: { type: "integer", minimum: 1, maximum: 365 } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const days = Number((request.query as { days?: number }).days ?? 7);
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        return reply
          .code(400)
          .send({ error: { code: "INVALID_DAYS", message: "days 必须是 1–365 的整数" } });
      }
      return getOpsMetrics({ db: opts.db, days });
    },
  );

  app.post(
    "/api/admin/ops/retention/run",
    { preHandler: app.requirePermission("admin.ops") },
    async (request, reply) => {
      try {
        const result = await opts.retention.run(request.user!.sub);
        return reply.code(200).send(result);
      } catch (error) {
        const payload = errorPayload(error);
        if (payload) return reply.code(payload.statusCode).send(payload.body);
        throw error;
      }
    },
  );
}
