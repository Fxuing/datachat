import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  createConversation,
  findOwnedConversation,
} from "../db/repositories/conversations.js";
import {
  insertConversationFile,
  insertConversationFileTable,
  listConversationFiles,
  listConversationFileTables,
  toConversationFileSummary,
  toConversationFileTableSummary,
  type ConversationFileSummary,
  type ConversationFileTableSummary,
} from "../db/repositories/conversation-files.js";
import {
  countFileDatasetsByUser,
  deleteOwnedFileDataset,
  findOwnedFileDataset,
  insertFileDataset,
  insertFileDatasetTable,
  listFileDatasetsByUser,
  listFileDatasetTables,
  toFileDatasetSummary,
  toFileDatasetTableSummary,
  updateOwnedFileDataset,
  type FileDatasetTableSummary,
} from "../db/repositories/file-datasets.js";
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
  copySqliteFile,
  removeConversationFileDir,
  removeDatasetDir,
  resolveConversationSqlitePath,
  resolveDatasetSqlitePath,
  sqliteFileExists,
} from "../services/file-store.js";

export interface FileDatasetRouteOptions {
  config: AppConfig;
  db: Db;
  runtime: RuntimeManager;
  getRuntime?: () => Promise<ModelRuntime>;
}

const MAX_DATASETS_PER_USER = 50;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const idParamsSchema = z.object({ id: z.string().uuid() });
const conversationIdParamsSchema = z.object({ conversationId: z.string().uuid() });

const saveDatasetBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional().nullable(),
});

const updateDatasetBodySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).optional().nullable(),
  })
  .refine((data) => data.name !== undefined || data.description !== undefined, {
    message: "至少提供名称或说明",
  });

const createFromDatasetBodySchema = z.object({
  datasetId: z.string().uuid(),
  title: z.string().trim().min(1).max(100).optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
  thinkingLevel: z.enum(THINKING_LEVELS).optional(),
});

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

export async function fileDatasetRoutes(
  app: FastifyInstance,
  opts: FileDatasetRouteOptions,
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

  app.get(
    "/api/file-datasets",
    { preHandler: app.requirePermission("chat.use") },
    async (request) => {
      const datasets = listFileDatasetsByUser(opts.db, request.user!.sub);
      return { datasets };
    },
  );

  app.post(
    "/api/file-datasets/from-conversation/:conversationId",
    {
      preHandler: app.requirePermission("chat.use"),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const params = conversationIdParamsSchema.safeParse(request.params);
      const body = saveDatasetBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      }

      const user = request.user!;
      const conversation = findOwnedConversation(opts.db, params.data.conversationId, user.sub);
      if (!conversation) {
        return reply.code(404).send(errorBody("NOT_FOUND", "会话不存在"));
      }
      if (conversation.sourceKind !== "file") {
        return reply.code(400).send(errorBody("VALIDATION", "只有文件分析会话可以保存为数据集"));
      }
      if (opts.runtime.isBusy(conversation.id)) {
        return reply
          .code(409)
          .send(errorBody("CONFLICT", "请等待当前回答完成后再保存数据集"));
      }

      if (countFileDatasetsByUser(opts.db, user.sub) >= MAX_DATASETS_PER_USER) {
        return reply
          .code(409)
          .send(errorBody("DATASET_LIMIT", `最多保存 ${MAX_DATASETS_PER_USER} 个数据集，请先删除不需要的数据集`));
      }

      const files = listConversationFiles(opts.db, conversation.id);
      const tables = listConversationFileTables(opts.db, conversation.id);
      if (tables.length === 0) {
        return reply.code(400).send(errorBody("VALIDATION", "当前会话没有可保存的数据表"));
      }

      const srcSqlite = resolveConversationSqlitePath(opts.config.dataDir, conversation.id);
      if (!(await sqliteFileExists(srcSqlite))) {
        return reply.code(404).send(errorBody("NOT_FOUND", "会话数据文件不存在"));
      }

      const datasetId = randomUUID();
      const destSqlite = resolveDatasetSqlitePath(opts.config.dataDir, datasetId);
      const sizeBytes = await copySqliteFile(srcSqlite, destSqlite);

      const fileType: "xlsx" | "csv" =
        files.length > 0 && files.every((file) => file.fileType === "csv") ? "csv" : "xlsx";
      const totalRows = tables.reduce((sum, table) => sum + table.rowCount, 0);
      const now = Date.now();
      const description = body.data.description?.trim() ? body.data.description.trim() : null;

      try {
        const savedTables: FileDatasetTableSummary[] = [];
        const datasetRow = opts.db.transaction((tx) => {
          const created = insertFileDataset(tx, {
            id: datasetId,
            userId: user.sub,
            name: body.data.name,
            description,
            fileType,
            fileCount: Math.max(files.length, 1),
            tableCount: tables.length,
            rowCount: totalRows,
            sizeBytes,
            createdAt: now,
          });
          for (const table of tables) {
            const tableRow = insertFileDatasetTable(tx, {
              datasetId: created.id,
              tableName: table.tableName,
              displayName: table.displayName,
              sheetName: table.sheetName,
              rowCount: table.rowCount,
              columns: table.columns,
              sampleRows: table.sampleRows,
              warnings: table.warnings,
              createdAt: now,
            });
            savedTables.push(toFileDatasetTableSummary(tableRow));
          }
          return created;
        });

        return reply.code(201).send({
          dataset: toFileDatasetSummary(datasetRow, savedTables),
        });
      } catch (dbError) {
        await removeDatasetDir(opts.config.dataDir, datasetId).catch(() => undefined);
        throw dbError;
      }
    },
  );

  app.patch(
    "/api/file-datasets/:id",
    { preHandler: app.requirePermission("chat.use") },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      const body = updateDatasetBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      }
      const updated = updateOwnedFileDataset(opts.db, params.data.id, request.user!.sub, {
        ...(body.data.name !== undefined ? { name: body.data.name } : {}),
        ...(body.data.description !== undefined
          ? { description: body.data.description?.trim() || null }
          : {}),
      });
      if (!updated) {
        return reply.code(404).send(errorBody("NOT_FOUND", "数据集不存在"));
      }
      const tables = listFileDatasetTables(opts.db, updated.id);
      return { dataset: toFileDatasetSummary(updated, tables) };
    },
  );

  app.delete(
    "/api/file-datasets/:id",
    { preHandler: app.requirePermission("chat.use") },
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      }
      const removed = deleteOwnedFileDataset(opts.db, params.data.id, request.user!.sub);
      if (!removed) {
        return reply.code(404).send(errorBody("NOT_FOUND", "数据集不存在"));
      }
      await removeDatasetDir(opts.config.dataDir, params.data.id).catch(() => undefined);
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/conversations/from-dataset",
    {
      preHandler: app.requirePermission("chat.use"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const body = createFromDatasetBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
      }

      const user = request.user!;
      const dataset = findOwnedFileDataset(opts.db, body.data.datasetId, user.sub);
      if (!dataset) {
        return reply.code(404).send(errorBody("NOT_FOUND", "数据集不存在"));
      }
      const tables = listFileDatasetTables(opts.db, dataset.id);
      if (tables.length === 0) {
        return reply.code(400).send(errorBody("VALIDATION", "数据集不包含有效数据表"));
      }

      const srcSqlite = resolveDatasetSqlitePath(opts.config.dataDir, dataset.id);
      if (!(await sqliteFileExists(srcSqlite))) {
        return reply.code(404).send(errorBody("NOT_FOUND", "数据集文件已丢失"));
      }

      let modelId = body.data.modelId;
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

      const conversationId = randomUUID();
      const destSqlite = resolveConversationSqlitePath(opts.config.dataDir, conversationId);
      await copySqliteFile(srcSqlite, destSqlite);

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
            title: body.data.title ?? null,
            modelId: modelId ?? null,
            thinkingLevel: body.data.thinkingLevel,
          });
          const fileRow = insertConversationFile(tx, {
            conversationId: created.id,
            userId: user.sub,
            fileName: `${dataset.name}（数据集）`,
            fileType: dataset.fileType,
            sizeBytes: dataset.sizeBytes,
            headerRow: 1,
            tableCount: tables.length,
            rowCount: dataset.rowCount,
            createdAt: now,
          });
          fileSummaries.push(toConversationFileSummary(fileRow));
          for (const table of tables) {
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
          return created;
        });

        return reply.code(201).send({
          conversation: toConversationResponse(conversation),
          files: fileSummaries,
          tables: tableSummaries,
        });
      } catch (dbError) {
        await removeConversationFileDir(opts.config.dataDir, conversationId).catch(() => undefined);
        throw dbError;
      }
    },
  );
}
