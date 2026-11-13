import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { findOwnedConversation } from "../db/repositories/conversations.js";
import type { RuntimeManager } from "../agent/runtime.js";

export interface QuestionRouteOptions {
  db: Db;
  runtime: RuntimeManager;
}

const paramsSchema = z.object({
  id: z.string().uuid(),
  toolCallId: z.string().trim().min(1).max(200),
});

const answerBodySchema = z
  .object({
    answers: z
      .array(
        z.object({
          questionIndex: z.number().int().min(0).max(3),
          optionIndexes: z.array(z.number().int().min(0).max(3)).max(4).optional(),
          text: z.string().max(2_000).optional(),
          notes: z.string().max(2_000).optional(),
        }),
      )
      .max(4)
      .optional(),
    globalNote: z.string().max(2_000).optional(),
    cancel: z.boolean().optional(),
  })
  .refine((body) => body.cancel === true || (body.answers?.length ?? 0) > 0, {
    message: "必须选择答案或取消",
  });

function error(code: string, message: string) {
  return { error: { code, message } };
}

/**
 * Browser side of the questionnaire extension. The tool blocks inside the agent
 * run until this endpoint forwards the answer through the plugin's event bus.
 */
export async function questionRoutes(app: FastifyInstance, opts: QuestionRouteOptions): Promise<void> {
  app.post(
    "/api/conversations/:id/questions/:toolCallId/answer",
    { preHandler: app.requirePermission("chat.use") },
    async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = answerBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send(error("VALIDATION", "参数不合法"));
    }

    const conversation = findOwnedConversation(opts.db, params.data.id, request.user!.sub);
    if (!conversation) {
      return reply.code(404).send(error("NOT_FOUND", "会话不存在"));
    }

    const verdict = opts.runtime.answerQuestion(
      conversation.id,
      params.data.toolCallId,
      body.data,
    );
    if (!verdict) {
      return reply.code(409).send(error("NO_ACTIVE_RUN", "该问题已结束或没有正在运行的会话"));
    }
    if (!verdict.ok) {
      return reply
        .code(409)
        .send(error(verdict.code ?? "ANSWER_REJECTED", verdict.reason ?? "答案未被接受"));
    }

    return reply.code(204).send();
    },
  );
}
