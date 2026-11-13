import "fastify";
import type { SessionPayload } from "../auth/jwt.js";
import type { UserAccess } from "../auth/access.js";
import type { UserRow } from "../db/repositories/users.js";
import type { Permission } from "@datachat/shared";

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionPayload;
    /** Fresh database row loaded by `authenticate` on every request. */
    authUser?: UserRow;
    /** Permissions and datasource scope resolved alongside `authUser`. */
    access?: UserAccess;
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePermission: (
      permission: Permission,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
