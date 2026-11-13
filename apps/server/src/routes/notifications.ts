import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import {
  countUnreadNotifications,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../db/repositories/notifications.js";

interface NotificationRoutesOptions {
  db: Db;
}

const idParamsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
} as const;

export async function notificationRoutes(
  app: FastifyInstance,
  opts: NotificationRoutesOptions,
): Promise<void> {
  app.get("/api/notifications", { preHandler: app.authenticate }, async (request) => {
    const userId = request.user!.sub;
    return {
      notifications: listNotifications(opts.db, userId),
      unread: countUnreadNotifications(opts.db, userId),
    };
  });

  app.post(
    "/api/notifications/:id/read",
    { preHandler: app.authenticate, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const changed = markNotificationRead(
        opts.db,
        (request.params as { id: string }).id,
        request.user!.sub,
        Date.now(),
      );
      if (!changed) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "通知不存在" } });
      }
      return reply.code(204).send();
    },
  );

  app.post("/api/notifications/read-all", { preHandler: app.authenticate }, async (request) => {
    const changed = markAllNotificationsRead(opts.db, request.user!.sub, Date.now());
    return { marked: changed };
  });
}
