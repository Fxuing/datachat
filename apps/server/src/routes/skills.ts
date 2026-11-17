import type { FastifyInstance } from "fastify";
import { canAccessDatasource } from "../auth/access.js";
import { listApplicableSkills } from "../agent/skills.js";
import type { Db } from "../db/client.js";

interface SkillRoutesOptions {
  db: Db;
}

export async function skillRoutes(app: FastifyInstance, opts: SkillRoutesOptions) {
  app.get(
    "/api/datasources/:id/skills",
    { preHandler: app.requirePermission("chat.use") },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!canAccessDatasource(request.access!, id)) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "数据源不存在" } });
      }
      return {
        skills: request.access!.permissions.has("skill.use")
          ? listApplicableSkills(opts.db, id).map((skill) => ({
              name: skill.name,
              description: skill.description,
              scope: skill.scope,
            }))
          : [],
      };
    },
  );
}
