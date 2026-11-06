import { SignJWT, jwtVerify } from "jose";
import type { UserRole } from "@datachat/shared";

export interface SessionPayload {
  sub: string;
  username: string;
  role: UserRole;
}

export function createSessionSigner(secret: string) {
  const key = new TextEncoder().encode(secret);

  return {
    sign(payload: SessionPayload): Promise<string> {
      return new SignJWT({ username: payload.username, role: payload.role })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(payload.sub)
        .setIssuedAt()
        .setExpirationTime("12h")
        .sign(key);
    },
    async verify(token: string): Promise<SessionPayload> {
      const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
      if (typeof payload.sub !== "string") throw new Error("missing sub");
      if (payload.role !== "admin" && payload.role !== "user") throw new Error("bad role");
      return {
        sub: payload.sub,
        username: typeof payload.username === "string" ? payload.username : "",
        role: payload.role,
      };
    },
  };
}

export type SessionSigner = ReturnType<typeof createSessionSigner>;
