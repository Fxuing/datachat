import type { FastifyInstance } from "fastify";
import type { RetentionService, OpsError } from "../services/ops-retention.js";

interface OpsRoutesOptions {
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
    { preHandler: app.requireAdmin },
    async () => opts.retention.preview(),
  );

  app.post(
    "/api/admin/ops/retention/run",
    { preHandler: app.requireAdmin },
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
