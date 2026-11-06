import "fastify";
import type { SessionPayload } from "../auth/jwt.js";
import type { UserRow } from "../db/repositories/users.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionPayload;
    /** Fresh database row loaded by `authenticate` on every request. */
    authUser?: UserRow;
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
