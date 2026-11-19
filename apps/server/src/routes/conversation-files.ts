import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  createConversation,
  findOwnedConversation,
  touchConversation,
} from "../db/repositories/conversations.js";
import {
  insertConversationFile,
  insertConversationFileTable,
  listConversationFiles,
  listConversationFileTables,
  summarizeConversationFileStorage,
  toConversationFileSummary,
  toConversationFileTableSummary,
  type ConversationFileSummary,
  type ConversationFileTableSummary,
} from "../db/repositories/conversation-files.js";
import {
  createAgentModelRuntime,
  modelKey,
  resolveChatModel,
} from "../agent/model-runtime.js";
import type { RuntimeManager } from "../agent/runtime.js";
import { resolveDefaultModelId } from "../services/app-settings.js";
import { toConversationResponse } from "../services/conversation-service.js";
import { enabledProviderIds } from "../services/llm-catalog.js";
import {
  FILE_MAX_FILES_PER_UPLOAD,
  FILE_MAX_HEADER_ROW,
  FileImportError,
  parseUploadedFiles,
  type ParsedFileResult,
  type UploadedFileInput,
} from "../services/file-import.js";
import {
  removeConversationFileDir,
  resolveConversationSqlitePath,
  sqliteFileExists,
  writeTablesToSqlite,
} from "../services/file-store.js";

export interface ConversationFileRouteOptions {
  config: AppConfig;
  db: Db;
  runtime: RuntimeManager;
  getRuntime?: () => Promise<ModelRuntime>;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const idParamsSchema = z.object({ id: z.string().uuid() });
const createOptionsSchema = z.object({
  title: z.string().trim().min(1).max(100).optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
  thinkingLevel: z.enum(THINKING_LEVELS).optional(),
});

interface CollectedMultipart {
  inputs: UploadedFileInput[];
  fields: Record<string, string>;
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

function mapUploadError(error: unknown): { status: number; code: string; message: string } | null {
  if (error instanceof FileImportError) {
    return { status: error.statusCode, code: error.code, message: error.message };
  }
  const fastifyCode = (error as { code?: unknown } | null)?.code;
  if (fastifyCode === "FST_REQ_FILE_TOO_LARGE") {
    return { status: 413, code: "FILE_TOO_LARGE", message: "单个文件不能超过 20 MB" };
  }
  if (fastifyCode === "FST_FILES_LIMIT") {
    return {
      status: 400,
      code: "TOO_MANY_FILES",
      message: `单次最多上传 ${FILE_MAX_FILES_PER_UPLOAD} 个文件`,
    };
  }
  if (fastifyCode === "FST_INVALID_MULTIPART_CONTENT_TYPE") {
    return { status: 400, code: "VALIDATION", message: "请使用 multipart/form-data 上传文件" };
  }
  return null;
}

function parseHeaderRowsField(
  fields: Record<string, string>,
  fileCount: number,
): Array<number | undefined> {
  const raw = fields.headerRows;
  if (raw === undefined || raw.trim() === "") {
    if (fields.headerRow !== undefined && fields.headerRow.trim() !== "") {
      const single = Number(fields.headerRow);
      if (!Number.isInteger(single) || single < 0 || single > FILE_MAX_HEADER_ROW) {
        throw new FileImportError(
          "INVALID_HEADER_ROW",
          `表头行必须是 0（自动）或 1-${FILE_MAX_HEADER_ROW} 之间的整数`,
          400,
        );
      }
      return new Array(fileCount).fill(single === 0 ? undefined : single);
    }
    return new Array(fileCount).fill(undefined);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FileImportError("INVALID_HEADER_ROW", "headerRows 必须是合法的 JSON 数组", 400);
  }
  if (!Array.isArray(parsed)) {
    throw new FileImportError("INVALID_HEADER_ROW", "headerRows 必须是数组", 400);
  }

  return Array.from({ length: fileCount }, (_, index) => {
    const val = parsed[index];
    if (val === undefined || val === null) return undefined;
    if (
      typeof val !== "number" ||
      !Number.isInteger(val) ||
      val < 0 ||
      val > FILE_MAX_HEADER_ROW
    ) {
      throw new FileImportError(
        "INVALID_HEADER_ROW",
        `表头行必须是 0（自动）或 1-${FILE_MAX_HEADER_ROW} 之间的整数`,
        400,
      );
    }
    return val === 0 ? undefined : val;
  });
}

async function readMultipartPayload(request: FastifyRequest): Promise<CollectedMultipart> {
  if (!request.isMultipart()) {
    throw new FileImportError("EMPTY_FILE", "请使用 multipart/form-data 上传文件", 400);
  }

  const rawFiles: Array<{ fileName: string; buffer: Buffer }> = [];
  const fields: Record<string, string> = {};

  for await (const part of request.parts()) {
    if (part.type === "file") {
      const buffer = await part.toBuffer();
      if (part.file.truncated) {
        throw new FileImportError(
          "FILE_TOO_LARGE",
          `文件「${part.filename || "unknown"}」超过单个文件 20 MB 上限`,
          413,
        );
      }
      rawFiles.push({
        fileName: part.filename || "uploaded_file",
        buffer,
      });
    } else {
      fields[part.fieldname] = typeof part.value === "string" ? part.value : String(part.value ?? "");
    }
  }

  const headerRows = parseHeaderRowsField(fields, rawFiles.length);
  const inputs: UploadedFileInput[] = rawFiles.map((file, index) => ({
    fileName: file.fileName,
    buffer: file.buffer,
    ...(headerRows[index] !== undefined ? { headerRow: headerRows[index] } : {}),
  }));

  return { inputs, fields };
}

function toPreviewFile(file: ParsedFileResult) {
  return {
    fileName: file.fileName,
    fileType: file.fileType,
    sizeBytes: file.sizeBytes,
    headerRow: file.headerRow,
    detectedHeaderRow: file.detectedHeaderRow,
    tableCount: file.tableCount,
    rowCount: file.rowCount,
    tables: file.tables.map((table) => ({
      tableName: table.tableName,
      displayName: table.displayName,
      sheetName: table.sheetName,
      rowCount: table.rowCount,
      columns: table.columns,
      sampleRows: table.sampleRows,
      warnings: table.warnings,
    })),
  };
}

export async function conversationFileRoutes(
  app: FastifyInstance,
  opts: ConversationFileRouteOptions,
): Promise<void> {
  let runtimePromise: Promise<ModelRuntime> | undefined;
  const getRuntime =
    opts.getRuntime ??
    (() =>
      (runtimePromise = (runtimePromise ?? createAgentModelRuntime(opts.config, opts.db)).catch(
        (error: unknown) => {
          runtimePromise = undefined;
          throw error;
        },
      )));
  const inFlightAppends = new Set<string>();

  app.post(
    "/api/files/preview",
    {
      preHandler: app.requirePermission("chat.use"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      try {
        const { inputs } = await readMultipartPayload(request);
        const parsed = await parseUploadedFiles(inputs);
        return reply.code(200).send({
          files: parsed.files.map(toPreviewFile),
          totalTables: parsed.totalTables,
          totalRows: parsed.totalRows,
        });
      } catch (error) {
        const mapped = mapUploadError(error);
        if (mapped) {
          return reply.code(mapped.status).send(errorBody(mapped.code, mapped.message));
        }
        throw error;
      }
    },
  );

  app.post(
    "/api/conversations/file",
    {
      preHandler: app.requirePermission("chat.use"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      try {
        const { inputs, fields } = await readMultipartPayload(request);
        const bodyParsed = createOptionsSchema.safeParse({
          ...(fields.title !== undefined && fields.title.trim() !== ""
            ? { title: fields.title }
            : {}),
          ...(fields.modelId !== undefined && fields.modelId.trim() !== ""
            ? { modelId: fields.modelId }
            : {}),
          ...(fields.thinkingLevel !== undefined && fields.thinkingLevel.trim() !== ""
            ? { thinkingLevel: fields.thinkingLevel }
            : {}),
        });
        if (!bodyParsed.success) {
          return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
        }

        const user = request.user!;
        let modelId = bodyParsed.data.modelId;
        if (modelId !== undefined) {
          const providerIds = enabledProviderIds(opts.db);
          let model: ReturnType<typeof resolveChatModel>;
          try {
            model = resolveChatModel(await getRuntime(), modelId, providerIds);
          } catch {
            return reply
              .code(503)
              .send(errorBody("MODEL_RUNTIME_UNAVAILABLE", "模型服务不可用"));
          }
          if (!model) {
            return reply.code(400).send(errorBody("VALIDATION", "模型不在白名单中"));
          }
          modelId = modelKey(model);
        } else {
          modelId =
            (await resolveDefaultModelId({
              db: opts.db,
              config: opts.config,
              getRuntime,
            })) ?? undefined;
        }

        const parsed = await parseUploadedFiles(inputs);
        const conversationId = randomUUID();
        const sqlitePath = resolveConversationSqlitePath(opts.config.dataDir, conversationId);
        await writeTablesToSqlite(sqlitePath, parsed.allTables, { mode: "create" });

        const now = Date.now();
        const fileSummaries: ConversationFileSummary[] = [];
        const tableSummaries: ConversationFileTableSummary[] = [];

        try {
          const conversation = opts.db.transaction((tx) => {
            const created = createConversation(tx, {
              id: conversationId,
              userId: user.sub,
              sourceKind: "file",
              datasourceId: null,
              title: bodyParsed.data.title ?? null,
              modelId: modelId ?? null,
              thinkingLevel: bodyParsed.data.thinkingLevel,
            });
            for (const file of parsed.files) {
              const fileRow = insertConversationFile(tx, {
                conversationId: created.id,
                userId: user.sub,
                fileName: file.fileName,
                fileType: file.fileType,
                sizeBytes: file.sizeBytes,
                headerRow: file.headerRow,
                tableCount: file.tableCount,
                rowCount: file.rowCount,
                createdAt: now,
              });
              fileSummaries.push(toConversationFileSummary(fileRow));
              for (const table of file.tables) {
                const tableRow = insertConversationFileTable(tx, {
                  conversationId: created.id,
                  fileId: fileRow.id,
                  tableName: table.tableName,
                  displayName: table.displayName,
                  sheetName: table.sheetName,
                  rowCount: table.rowCount,
                  columns: table.columns,
                  sampleRows: table.sampleRows,
                  warnings: table.warnings,
                  createdAt: now,
                });
                tableSummaries.push(toConversationFileTableSummary(tableRow));
              }
            }
            return created;
          });

          return reply.code(201).send({
            conversation: toConversationResponse(conversation),
            files: fileSummaries,
            tables: tableSummaries,
          });
        } catch (dbError) {
          await removeConversationFileDir(opts.config.dataDir, conversationId).catch(
            () => undefined,
          );
          throw dbError;
        }
      } catch (error) {
        const mapped = mapUploadError(error);
        if (mapped) {
          return reply.code(mapped.status).send(errorBody(mapped.code, mapped.message));
        }
        throw error;
      }
    },
  );

  app.get(
    "/api/conversations/:id/files",
    { preHandler: app.requirePermission("chat.use") },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      }
      const conversation = findOwnedConversation(opts.db, params.data.id, request.user!.sub);
      if (!conversation) {
        return reply.code(404).send(errorBody("NOT_FOUND", "会话不存在"));
      }
      return {
        files: listConversationFiles(opts.db, conversation.id),
        tables: listConversationFileTables(opts.db, conversation.id),
      };
    },
  );

  app.post(
    "/api/conversations/:id/files",
    {
      preHandler: app.requirePermission("chat.use"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      }
      const user = request.user!;
      const conversation = findOwnedConversation(opts.db, params.data.id, user.sub);
      if (!conversation) {
        return reply.code(404).send(errorBody("NOT_FOUND", "会话不存在"));
      }
      if (conversation.sourceKind !== "file") {
        return reply.code(400).send(errorBody("VALIDATION", "只有文件分析会话支持追加上传文件"));
      }
      if (opts.runtime.isBusy(conversation.id) || inFlightAppends.has(conversation.id)) {
        return reply
          .code(409)
          .send(errorBody("CONFLICT", "请等待当前操作完成后再追加文件"));
      }

      inFlightAppends.add(conversation.id);
      try {
        const { inputs } = await readMultipartPayload(request);
        const existing = summarizeConversationFileStorage(opts.db, conversation.id);
        const parsed = await parseUploadedFiles(inputs, {
          existingTableNames: existing.tableNames,
          existingTableCount: existing.tableCount,
          existingRowCount: existing.rowCount,
        });

        const sqlitePath = resolveConversationSqlitePath(opts.config.dataDir, conversation.id);
        const mode = (await sqliteFileExists(sqlitePath)) ? "append" : "create";
        await writeTablesToSqlite(sqlitePath, parsed.allTables, { mode });

        const now = Date.now();
        const addedFiles: ConversationFileSummary[] = [];
        const addedTables: ConversationFileTableSummary[] = [];

        opts.db.transaction((tx) => {
          for (const file of parsed.files) {
            const fileRow = insertConversationFile(tx, {
              conversationId: conversation.id,
              userId: user.sub,
              fileName: file.fileName,
              fileType: file.fileType,
              sizeBytes: file.sizeBytes,
              headerRow: file.headerRow,
              tableCount: file.tableCount,
              rowCount: file.rowCount,
              createdAt: now,
            });
            addedFiles.push(toConversationFileSummary(fileRow));
            for (const table of file.tables) {
              const tableRow = insertConversationFileTable(tx, {
                conversationId: conversation.id,
                fileId: fileRow.id,
                tableName: table.tableName,
                displayName: table.displayName,
                sheetName: table.sheetName,
                rowCount: table.rowCount,
                columns: table.columns,
                sampleRows: table.sampleRows,
                warnings: table.warnings,
                createdAt: now,
              });
              addedTables.push(toConversationFileTableSummary(tableRow));
            }
          }
          touchConversation(tx, conversation.id, now);
        });

        return reply.code(201).send({
          files: listConversationFiles(opts.db, conversation.id),
          tables: listConversationFileTables(opts.db, conversation.id),
          addedFiles,
          addedTables,
        });
      } catch (error) {
        const mapped = mapUploadError(error);
        if (mapped) {
          return reply.code(mapped.status).send(errorBody(mapped.code, mapped.message));
        }
        throw error;
      } finally {
        inFlightAppends.delete(conversation.id);
      }
    },
  );
}
