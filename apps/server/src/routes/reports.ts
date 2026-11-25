import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { REPORT_MAX_ARTIFACTS, REPORT_MAX_MARKDOWN_LENGTH } from "@datachat/shared";
import type { Db } from "../db/client.js";
import {
  deleteReport,
  findReport,
  parseReportArtifactIds,
  updateReport,
} from "../db/repositories/reports.js";
import { canReadReport, createReport, toReportDetail, type ReportErrorCode } from "../services/reports.js";
import type { ArtifactStore } from "../services/artifacts.js";
import { artifactRunVisible } from "../services/scope-access.js";

export interface ReportRouteOptions {
  db: Db;
  artifacts: ArtifactStore;
}

const idParamsSchema = z.object({ id: z.string().uuid() });
const createBodySchema = z.object({
  conversationId: z.string().uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  markdown: z.string().min(1).max(REPORT_MAX_MARKDOWN_LENGTH).optional(),
  artifactIds: z
    .array(z.string().uuid())
    .min(1)
    .max(REPORT_MAX_ARTIFACTS),
});

const updateBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    markdown: z
      .string()
      .max(REPORT_MAX_MARKDOWN_LENGTH)
      .refine((value) => value.trim().length > 0, { message: "正文不能为空" })
      .optional(),
  })
  .refine((data) => data.title !== undefined || data.markdown !== undefined, {
    message: "至少提供标题或正文",
  });

const ERROR_STATUS: Record<ReportErrorCode, number> = {
  EMPTY_ARTIFACTS: 400,
  TOO_MANY_ARTIFACTS: 400,
  ARTIFACT_CONVERSATION_MISMATCH: 400,
  INVALID_ARTIFACT_KIND: 400,
  CONVERSATION_NOT_FOUND: 404,
  ARTIFACT_NOT_FOUND: 404,
};

function error(code: string, message: string) {
  return { error: { code, message } };
}

/** A report is only readable while every artifact run stays inside the viewer's scope. */
function reportScopeVisible(
  opts: ReportRouteOptions,
  report: { artifactIdsJson: string },
  isAdmin: boolean,
): boolean {
  if (isAdmin) return true;
  return parseReportArtifactIds(report).every((id) => {
    const meta = opts.artifacts.findMeta(id);
    return Boolean(meta) && artifactRunVisible(opts.db, meta!.runId, false);
  });
}

export async function reportRoutes(
  app: FastifyInstance,
  opts: ReportRouteOptions,
): Promise<void> {
  app.post(
    "/api/reports",
    { preHandler: app.requirePermission("report.create") },
    async (request, reply) => {
      const body = createBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send(error("VALIDATION", "参数不合法"));
      }

      const result = createReport({
        db: opts.db,
        artifacts: opts.artifacts,
        userId: request.user!.sub,
        conversationId: body.data.conversationId,
        artifactIds: body.data.artifactIds,
        ...(body.data.title !== undefined ? { title: body.data.title } : {}),
        ...(body.data.markdown !== undefined ? { markdown: body.data.markdown } : {}),
      });
      if (!result.ok) {
        const status = ERROR_STATUS[result.code];
        return reply
          .code(status)
          .send(error(status === 404 ? "NOT_FOUND" : "VALIDATION", result.message));
      }
      return reply.code(201).send({ report: result.report });
    },
  );

  app.get("/api/reports/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(error("VALIDATION", "参数不合法"));
    }
    const user = request.user!;
    const report = findReport(opts.db, params.data.id);
    if (
      !report ||
      !canReadReport(report, user.sub, user.role === "admin") ||
      !reportScopeVisible(opts, report, user.role === "admin")
    ) {
      return reply.code(404).send(error("NOT_FOUND", "报告不存在"));
    }
    return { report: toReportDetail(report) };
  });

  app.patch(
    "/api/reports/:id",
    { preHandler: app.requirePermission("report.create") },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      const body = updateBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send(error("VALIDATION", "参数不合法"));
      }
      const user = request.user!;
      const report = findReport(opts.db, params.data.id);
      if (
        !report ||
        !canReadReport(report, user.sub, user.role === "admin") ||
        !reportScopeVisible(opts, report, user.role === "admin")
      ) {
        return reply.code(404).send(error("NOT_FOUND", "报告不存在"));
      }
      const updated = updateReport(opts.db, report.id, {
        ...(body.data.title !== undefined ? { title: body.data.title } : {}),
        ...(body.data.markdown !== undefined ? { markdown: body.data.markdown } : {}),
      });
      if (!updated) {
        return reply.code(404).send(error("NOT_FOUND", "报告不存在"));
      }
      return { report: toReportDetail(updated) };
    },
  );

  app.delete("/api/reports/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(error("VALIDATION", "参数不合法"));
    }
    const user = request.user!;
    const report = findReport(opts.db, params.data.id);
    if (!report || !canReadReport(report, user.sub, user.role === "admin")) {
      return reply.code(404).send(error("NOT_FOUND", "报告不存在"));
    }
    deleteReport(opts.db, report.id);
    return reply.code(204).send();
  });
}
