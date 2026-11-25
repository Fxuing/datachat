import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { excelWorkbookSpecSchema } from "@datachat/shared";
import type { Db } from "../db/client.js";
import { queryAudit } from "../db/schema.js";
import { findConversation } from "../db/repositories/conversations.js";
import { recordAudit } from "../services/audit.js";
import type { ArtifactRecord, ArtifactStore, ColumnInfo } from "../services/artifacts.js";
import {
  csvStream,
  EXPORT_MAX_ROWS,
  multiSheetXlsxStream,
  sanitizeExcelFilename,
  xlsxStream,
} from "../services/export.js";
import { artifactRunVisible } from "../services/scope-access.js";

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
  if (!artifactRunVisible(opts.db, artifact.runId, user.role === "admin")) return null;
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
  app.get(
    "/api/artifacts/:id",
    { preHandler: app.requirePermission("chat.use") },
    async (request, reply) => {
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
    },
  );

  app.get(
    "/api/artifacts/:id/rows",
    { preHandler: app.requirePermission("chat.use") },
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
      if (artifact.kind !== "result" || !artifact.storagePath) {
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
    { preHandler: app.requirePermission("export.data") },
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
      const format = query.data.format;
      if (artifact.kind === "excel") {
        return streamExcelWorkbookDownload(opts, artifact, format, request.user!, reply);
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

      const audit = exportAuditContext(opts.db, artifact, request.user!.sub);

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
      let streamError: unknown = null;
      try {
        // pipeline() resolves once the response emits finish/close without error and
        // rejects when the client disconnects or the source stream fails.
        await pipeline(stream, reply.raw);
      } catch (error) {
        streamError = error;
        if (!reply.raw.writableEnded) reply.raw.destroy();
      } finally {
        reply.raw.off("close", closeSource);
        void source.return(undefined);
      }
      // Exactly one audit row per download, written only after the response stream
      // finished (ok) or broke mid-stream (error).
      safeRecordExport(opts.db, {
        ...audit,
        action: "export",
        status: streamError ? "error" : "ok",
        ...(streamError
          ? {
              errorMessage:
                streamError instanceof Error ? streamError.message : String(streamError),
            }
          : {}),
        rowCount: artifact.rowCount,
        detail: { artifactId: artifact.id, format },
      });
      return reply;
    },
  );
}

/** Stream a multi-sheet workbook by re-validating every sheet's access and scope snapshot first. */
async function streamExcelWorkbookDownload(
  opts: ArtifactRouteOptions,
  artifact: ArtifactRecord,
  format: "csv" | "xlsx",
  user: { sub: string; role: string },
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (format !== "xlsx") {
    return reply
      .code(400)
      .send(error("NOT_EXPORTABLE", "Excel 工作簿仅支持导出为 .xlsx 格式"));
  }
  const parsedSpec = excelWorkbookSpecSchema.safeParse(parseSpec(artifact.specJson));
  if (!parsedSpec.success) {
    return reply.code(400).send(error("INVALID_ARTIFACT", "Excel 工作簿配置无效"));
  }

  const resolvedSheets: Array<{ name: string; artifact: ArtifactRecord }> = [];
  let totalRows = 0;
  for (const sheet of parsedSpec.data.sheets) {
    const sheetArtifact = findReadableArtifact(opts, sheet.artifactId, user);
    if (
      !sheetArtifact ||
      sheetArtifact.kind !== "result" ||
      (artifact.conversationId && sheetArtifact.conversationId !== artifact.conversationId)
    ) {
      return reply
        .code(404)
        .send(error("NOT_FOUND", "工作表关联的查询结果不存在或无权访问"));
    }
    totalRows += sheetArtifact.rowCount;
    resolvedSheets.push({ name: sheet.name, artifact: sheetArtifact });
  }

  if (totalRows > EXPORT_MAX_ROWS) {
    return reply
      .code(413)
      .send(error("EXPORT_TOO_LARGE", "工作簿总行数过多，请缩小查询范围后再导出"));
  }

  const opened: Array<{
    name: string;
    columns: ColumnInfo[];
    source: AsyncGenerator<unknown[], void, void>;
  }> = [];
  try {
    for (const entry of resolvedSheets) {
      const rows = opts.artifacts.openRows(entry.artifact.id);
      const first = await rows.next();
      opened.push({
        name: entry.name,
        columns: entry.artifact.columns,
        source: prependFirst(first, rows),
      });
    }
  } catch (readError) {
    await Promise.allSettled(opened.map((item) => item.source.return(undefined)));
    if (isEnoent(readError)) {
      return reply.code(410).send(error("ARTIFACT_GONE", "结果文件已丢失"));
    }
    throw readError;
  }

  const audit = exportAuditContext(opts.db, artifact, user.sub);
  if (!audit.sqlText && resolvedSheets[0]) {
    const sheetAudit = exportAuditContext(opts.db, resolvedSheets[0].artifact, user.sub);
    audit.sqlText = sheetAudit.sqlText;
    audit.datasourceId ??= sheetAudit.datasourceId;
  }

  const safeStem = sanitizeExcelFilename(
    parsedSpec.data.filename,
    `datachat-${artifact.id.slice(0, 8)}`,
  );
  const downloadFilename = `${safeStem}.xlsx`;

  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(downloadFilename)}`,
    "Cache-Control": "no-store",
  });

  const stream = multiSheetXlsxStream(
    opened.map((item) => ({
      name: item.name,
      columns: item.columns,
      rows: item.source,
    })),
  );
  const closeAllSources = (): void => {
    for (const item of opened) {
      void item.source.return(undefined);
    }
  };
  reply.raw.once("close", closeAllSources);
  let streamError: unknown = null;
  try {
    await pipeline(stream, reply.raw);
  } catch (streamFailure) {
    streamError = streamFailure;
    if (!reply.raw.writableEnded) reply.raw.destroy();
  } finally {
    reply.raw.off("close", closeAllSources);
    closeAllSources();
  }

  safeRecordExport(opts.db, {
    ...audit,
    action: "export",
    status: streamError ? "error" : "ok",
    ...(streamError
      ? {
          errorMessage:
            streamError instanceof Error ? streamError.message : String(streamError),
        }
      : {}),
    rowCount: totalRows,
    detail: {
      artifactId: artifact.id,
      format: "xlsx",
      filename: downloadFilename,
      sheetCount: opened.length,
      sheetArtifactIds: resolvedSheets.map((item) => item.artifact.id),
    },
  });
  return reply;
}
