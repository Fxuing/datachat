import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import {
  findOwnedScheduledTask,
  listScheduledTaskRuns,
} from "../db/repositories/scheduled-tasks.js";
import { type ScheduledTaskService, ScheduledTaskError } from "../services/scheduled-tasks.js";
import { type ScheduleError } from "../services/schedule.js";

interface ScheduledTaskRoutesOptions {
  db: Db;
  scheduledTasks: ScheduledTaskService;
}

const idParamsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
} as const;

const taskBodySchema = {
  type: "object",
  required: ["name", "prompt", "datasourceId", "cronExpression", "timezone"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    prompt: { type: "string", minLength: 1, maxLength: 1000 },
    datasourceId: { type: "string", format: "uuid" },
    cronExpression: { type: "string", minLength: 1, maxLength: 100 },
    timezone: { type: "string", minLength: 1, maxLength: 64 },
    modelId: { type: ["string", "null"], maxLength: 200 },
    enabled: { type: "boolean" },
  },
} as const;

const taskPatchSchema = {
  type: "object",
  additionalProperties: false,
  properties: taskBodySchema.properties,
} as const;

function sendError(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, error: unknown) {
  if (error instanceof ScheduledTaskError) {
    return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
  }
  if (error instanceof Error && "code" in error) {
    const scheduleError = error as ScheduleError;
    return reply.code(400).send({
      error: { code: scheduleError.code, message: scheduleError.message },
    });
  }
  throw error;
}

function ensureReportPermission(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, request: { access?: { permissions: Set<string> } }) {
  if (!request.access?.permissions.has("report.create")) {
    return reply.code(403).send({
      error: { code: "PERMISSION_DENIED", message: "缺少权限：生成报告", permission: "report.create" },
    });
  }
  return undefined;
}

export async function scheduledTaskRoutes(
  app: FastifyInstance,
  opts: ScheduledTaskRoutesOptions,
): Promise<void> {
  app.get("/api/scheduled-tasks", { preHandler: app.requirePermission("chat.use") }, async (request) => {
    return { tasks: opts.scheduledTasks.list(request.user!.sub) };
  });

  app.post(
    "/api/scheduled-tasks",
    { preHandler: app.requirePermission("chat.use"), schema: { body: taskBodySchema } },
    async (request, reply) => {
      const denied = ensureReportPermission(reply, request);
      if (denied) return denied;
      try {
        return await opts.scheduledTasks.create(request.user!.sub, request.body as never);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.patch(
    "/api/scheduled-tasks/:id",
    {
      preHandler: app.requirePermission("chat.use"),
      schema: { params: idParamsSchema, body: taskPatchSchema },
    },
    async (request, reply) => {
      const denied = ensureReportPermission(reply, request);
      if (denied) return denied;
      try {
        return await opts.scheduledTasks.update(
          request.user!.sub,
          (request.params as { id: string }).id,
          request.body as never,
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.delete(
    "/api/scheduled-tasks/:id",
    { preHandler: app.requirePermission("chat.use"), schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        opts.scheduledTasks.remove(request.user!.sub, id);
        return reply.code(204).send();
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post(
    "/api/scheduled-tasks/:id/run",
    { preHandler: app.requirePermission("chat.use"), schema: { params: idParamsSchema } },
    async (request, reply) => {
      try {
        return await opts.scheduledTasks.runNow(
          request.user!.sub,
          (request.params as { id: string }).id,
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    "/api/scheduled-tasks/:id/runs",
    { preHandler: app.requirePermission("chat.use"), schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const task = findOwnedScheduledTask(opts.db, id, request.user!.sub);
      if (!task) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "定时任务不存在" } });
      }
      return { runs: listScheduledTaskRuns(opts.db, id) };
    },
  );
}
