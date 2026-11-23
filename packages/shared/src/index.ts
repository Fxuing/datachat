import { z } from "zod";

/** Canonical username form: trimmed and lower-cased at every DB boundary. */
export function normalizeUsername(name: string): string {
  return name.trim().toLowerCase();
}

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

export const datasourceTypeSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]{1,31}$/, "数据源类型不合法");
export type DatasourceType = z.infer<typeof datasourceTypeSchema>;

export const datasourceOptionsSchema = z.record(
  z.string().min(1).max(64),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

export const datasourceInputSchema = z.object({
  name: z.string().trim().min(1).max(64),
  type: datasourceTypeSchema,
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  database: z.string().trim().min(1).max(128),
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(500).optional(),
  sslMode: z.enum(["disable", "require", "no-verify"]).default("disable"),
  /** Allow saving an account that has write grants; queries stay read-only. */
  allowWriteAccount: z.boolean().default(false),
  /** Driver-specific options declared in the driver's manifest.optionsSchema. */
  options: datasourceOptionsSchema.optional(),
});
export type DatasourceInput = z.infer<typeof datasourceInputSchema>;

/** Report body budget; shared so the route, tool and editor agree. */
export const REPORT_MAX_MARKDOWN_LENGTH = 50_000;
/** One report references at most this many artifacts (spec §11.3). */
export const REPORT_MAX_ARTIFACTS = 20;

export interface ReportSummary {
  id: string;
  conversationId: string;
  title: string;
  artifactIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ReportDetail extends ReportSummary {
  markdown: string;
}

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export * from "./events.js";
export * from "./permissions.js";
export * from "./open-platform.js";
export type {
  ConnectionMode,
  DatasourceDriverCapabilities,
  DatasourceDriverManifest,
  OptionFieldSchema,
  OptionValue,
  PublicDriverDescriptor,
} from "@datachat/datasource-sdk";
