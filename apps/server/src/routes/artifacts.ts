import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { queryAudit } from "../db/schema.js";
import { findConversation } from "../db/repositories/conversations.js";
import { recordAudit } from "../services/audit.js";
import type { ArtifactRecord, ArtifactStore } from "../services/artifacts.js";
import { csvStream, EXPORT_MAX_ROWS, xlsxStream } from "../services/export.js";

export interface ArtifactRouteOptions {
  db: Db;
  artifacts: ArtifactStore;
}

const idParamsSchema = z.object({ id: z.string().uuid() });
const rowsQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});
const downloadQuerySchema = z.object({
  format: z.enum(["csv", "xlsx"]).default("csv"),
});

function error(code: string, message: string) {
  return { error: { code, message } };
}

function isEnoent(value: unknown): boolean {
  return (
    value instanceof Error && (value as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** Owners see their artifacts; admins may audit any artifact. */
function canReadArtifact(
  artifact: ArtifactRecord,
  user: { sub: string; role: string },
): boolean {
  return artifact.userId === user.sub || user.role === "admin";
}

function findReadableArtifact(
  opts: ArtifactRouteOptions,
  id: string,
  user: { sub: string; role: string },
): ArtifactRecord | null {
  const artifact = opts.artifacts.findMeta(id);
  if (!artifact || !canReadArtifact(artifact, user)) return null;
  return artifact;
}

function parseSpec(raw: string | null): unknown {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed ?? null;
  } catch {
    return null;
  }
}

/** The SQL behind an artifact comes from the run that produced it. */
function exportAuditContext(
  db: Db,
  artifact: ArtifactRecord,
  actorId: string,
): {
  runId: string | null;
  conversationId: string | null;
  userId: string;
  datasourceId: string | null;
  sqlText: string;
} {
  const conversation = artifact.conversationId
    ? findConversation(db, artifact.conversationId)
    : undefined;
  let datasourceId = conversation?.datasourceId ?? null;
  let sqlText = "";
  if (artifact.runId) {
    const auditRow = db
      .select({ sqlText: queryAudit.sqlText, datasourceId: queryAudit.datasourceId })
      .from(queryAudit)
      .where(
        and(eq(queryAudit.runId, artifact.runId), eq(queryAudit.action, "query")),
      )
      .orderBy(desc(queryAudit.createdAt))
      .get();
    if (auditRow) {
      sqlText = auditRow.sqlText;
      datasourceId = auditRow.datasourceId ?? datasourceId;
    }
  }
  return {
    runId: artifact.runId,
    conversationId: artifact.conversationId,
    userId: actorId,
    datasourceId,
    sqlText,
  };
}

/** Give an export audit the artifact-level totals rather than a preview count. */
function safeRecordExport(
  db: Db,
  input: Parameters<typeof recordAudit>[1],
): void {
  try {
    recordAudit(db, input);
  } catch {
    // The download already started; an audit failure must not break it.
  }
}

async function* prependFirst(
  first: IteratorResult<unknown[]>,
  rest: AsyncGenerator<unknown[], void, void>,
): AsyncGenerator<unknown[], void, void> {
  try {
    if (!first.done) yield first.value;
    for (;;) {
      const next = await rest.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await rest.return(undefined);
  }
}

export async function artifactRoutes(
  app: FastifyInstance,
  opts: ArtifactRouteOptions,
): Promise<void> {
  app.get("/api/artifacts/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(error("VALIDATION", "参数不合法"));
    }
    const artifact = findReadableArtifact(opts, params.data.id, request.user!);
    if (!artifact) {
      return reply.code(404).send(error("NOT_FOUND", "结果不存在"));
    }
    return {
      id: artifact.id,
      kind: artifact.kind,
      conversationId: artifact.conversationId,
      rowCount: artifact.rowCount,
      truncated: artifact.truncated,
      columns: artifact.columns,
      createdAt: artifact.createdAt,
      spec: parseSpec(artifact.specJson ?? null),
    };
  });

  app.get(
    "/api/artifacts/:id/rows",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      const query = rowsQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) {
        return reply.code(400).send(error("VALIDATION", "参数不合法"));
      }
      const artifact = findReadableArtifact(opts, params.data.id, request.user!);
      if (!artifact) {
        return reply.code(404).send(error("NOT_FOUND", "结果不存在"));
      }
      const { offset, limit } = query.data;
      if (artifact.kind === "chart" || !artifact.storagePath) {
        return { columns: artifact.columns, rows: [], total: artifact.rowCount };
      }

      const rows: unknown[][] = [];
      let index = 0;
      try {
        for await (const row of opts.artifacts.openRows(artifact.id)) {
          if (index >= offset && rows.length < limit) {
            rows.push(row);
            if (rows.length === limit) break;
          }
          index += 1;
        }
      } catch (readError) {
        if (isEnoent(readError)) {
          return reply.code(410).send(error("ARTIFACT_GONE", "结果文件已丢失"));
        }
        throw readError;
      }
      return { columns: artifact.columns, rows, total: artifact.rowCount };
    },
  );

  app.get(
    "/api/artifacts/:id/download",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      const query = downloadQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) {
        return reply.code(400).send(error("VALIDATION", "参数不合法"));
      }
      const artifact = findReadableArtifact(opts, params.data.id, request.user!);
      if (!artifact) {
        return reply.code(404).send(error("NOT_FOUND", "结果不存在"));
      }
      if (artifact.kind !== "result") {
        return reply.code(400).send(error("NOT_EXPORTABLE", "该结果不支持下载"));
      }
      if (artifact.rowCount > EXPORT_MAX_ROWS) {
        return reply
          .code(413)
          .send(error("EXPORT_TOO_LARGE", "结果行数过多，请缩小查询范围后再导出"));
      }

      // Open before hijacking the reply so a missing file still yields 410 JSON.
      const rows = opts.artifacts.openRows(artifact.id);
      let first: IteratorResult<unknown[]>;
      try {
        first = await rows.next();
      } catch (readError) {
        if (isEnoent(readError)) {
          return reply.code(410).send(error("ARTIFACT_GONE", "结果文件已丢失"));
        }
        throw readError;
      }

      const format = query.data.format;
      const audit = exportAuditContext(opts.db, artifact, request.user!.sub);
      safeRecordExport(opts.db, {
        ...audit,
        action: "export",
        status: "ok",
        rowCount: artifact.rowCount,
        detail: { artifactId: artifact.id, format },
      });

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type":
          format === "csv"
            ? "text/csv; charset=utf-8"
            : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(
          `datachat-${artifact.id.slice(0, 8)}.${format}`,
        )}`,
        "Cache-Control": "no-store",
      });

      const source = prependFirst(first, rows);
      const stream =
        format === "csv"
          ? csvStream(artifact.columns, source)
          : xlsxStream(artifact.columns, source);
      // pipeline() destroys `stream` on disconnect; also close the row generator so
      // the JSONL file handle is released even if the readable is mid-read.
      const closeSource = (): void => {
        void source.return(undefined);
      };
      reply.raw.once("close", closeSource);
      try {
        await pipeline(stream, reply.raw);
      } catch (streamError) {
        safeRecordExport(opts.db, {
          ...audit,
          action: "export",
          status: "error",
          errorMessage:
            streamError instanceof Error ? streamError.message : String(streamError),
          detail: { artifactId: artifact.id, format },
        });
        if (!reply.raw.writableEnded) reply.raw.destroy();
      } finally {
        reply.raw.off("close", closeSource);
        void source.return(undefined);
      }
      return reply;
    },
  );
}
