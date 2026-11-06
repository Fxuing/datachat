import { z } from "zod";

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const userRoleSchema = z.enum(["admin", "user"]);
export type UserRole = z.infer<typeof userRoleSchema>;

export const publicUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string().nullable(),
  role: userRoleSchema,
  status: z.enum(["active", "disabled"]),
});
export type PublicUser = z.infer<typeof publicUserSchema>;

export const datasourceTypeSchema = z.enum(["mysql", "postgres"]);
export type DatasourceType = z.infer<typeof datasourceTypeSchema>;

export const datasourceInputSchema = z.object({
  name: z.string().trim().min(1).max(64),
  type: datasourceTypeSchema,
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  database: z.string().trim().min(1).max(128),
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(500).optional(),
  sslMode: z.enum(["disable", "require"]).default("disable"),
});
export type DatasourceInput = z.infer<typeof datasourceInputSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
