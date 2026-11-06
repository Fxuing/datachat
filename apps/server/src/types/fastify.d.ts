import "fastify";
import type { SessionPayload } from "../auth/jwt.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionPayload;
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
