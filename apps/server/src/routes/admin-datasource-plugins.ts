import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import type { PoolRegistry } from "../agent/datasource/pool.js";
import type { DriverRegistry } from "../drivers/registry.js";
import { PLUGIN_MAX_UPLOAD_BYTES } from "../drivers/archive.js";
import { safeRecordAuditEvent } from "../services/audit.js";
import {
  DatasourcePluginError,
  deleteDatasourcePlugin,
  listAdminDatasourcePlugins,
  setDatasourcePluginEnabled,
  uploadDatasourcePlugin,
} from "../services/datasource-plugins.js";

export interface AdminDatasourcePluginRouteOptions {
  db: Db;
  config: AppConfig;
  drivers: DriverRegistry;
  pools: PoolRegistry;
}

const driverIdParamsSchema = z.object({
  driverId: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/, "驱动标识格式无效"),
});

const toggleBodySchema = z.object({
  enabled: z.boolean(),
});

function sendPluginError(reply: FastifyReply, err: unknown) {
  if (err instanceof DatasourcePluginError) {
    return reply.code(err.statusCode).send({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
  }
  const code = (err as { code?: string })?.code;
  if (code === "FST_REQ_FILE_TOO_LARGE" || code === "FST_FILES_LIMIT") {
    return reply.code(413).send({
      error: {
        code: "ARCHIVE_TOO_LARGE",
        message: "插件包体积超过 20 MB 上限",
      },
    });
  }
  throw err;
}

export async function adminDatasourcePluginRoutes(
  app: FastifyInstance,
  opts: AdminDatasourcePluginRouteOptions,
): Promise<void> {
  const { db, config, drivers, pools } = opts;
  const preHandler = app.requirePermission("admin.datasources");

  const audit = (
    request: FastifyRequest,
    detail: Record<string, unknown>,
    status: "ok" | "error" | "rejected" = "ok",
  ) => {
    safeRecordAuditEvent(db, {
      actorUserId: request.user!.sub,
      action: "ops",
      status,
      ip: request.ip,
      sqlText: `datasource_plugin:${String(detail.driverId ?? detail.op ?? "unknown")}`,
      detail: { category: "datasource_plugin", ...detail },
    });
  };

  app.get("/api/admin/datasource-plugins", { preHandler }, async () => {
    return listAdminDatasourcePlugins({ db, config, drivers });
  });

  app.post("/api/admin/datasource-plugins/upload", { preHandler }, async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(400).send({
        error: { code: "INVALID_REQUEST", message: "请使用 multipart/form-data 上传插件包" },
      });
    }

    let fileBuffer: Buffer | null = null;
    let fileName = "";
    let replace = false;

    try {
      for await (const part of request.parts()) {
        if (part.type === "field") {
          if (part.fieldname === "replace") {
            replace = part.value === "true" || part.value === "1";
          }
          continue;
        }
        if (part.fieldname !== "file" && fileBuffer !== null) {
          part.file.resume();
          continue;
        }
        fileName = part.filename || "plugin.mjs";
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of part.file) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buf.length;
          if (total > PLUGIN_MAX_UPLOAD_BYTES) {
            part.file.resume();
            throw new DatasourcePluginError("ARCHIVE_TOO_LARGE", "插件包大小不能超过 20 MB", 413);
          }
          chunks.push(buf);
        }
        if (part.file.truncated) {
          throw new DatasourcePluginError("ARCHIVE_TOO_LARGE", "插件包大小不能超过 20 MB", 413);
        }
        fileBuffer = Buffer.concat(chunks);
      }

      if (!fileBuffer) {
        return reply.code(400).send({
          error: { code: "MISSING_FILE", message: "请选择要上传的插件包文件（.mjs / .zip / .tgz）" },
        });
      }

      const result = await uploadDatasourcePlugin({
        db,
        config,
        drivers,
        pools,
        buffer: fileBuffer,
        fileName,
        replace,
        uploadedBy: request.user!.sub,
      });

      audit(request, {
        op: result.replaced ? "upgrade" : "upload",
        driverId: result.plugin.id,
        label: result.plugin.label,
        version: result.plugin.version,
        fileName: result.plugin.fileName,
        sha256: result.plugin.sha256,
        sizeBytes: result.plugin.sizeBytes,
      });

      return reply.code(201).send(result);
    } catch (err) {
      if (err instanceof DatasourcePluginError) {
        audit(
          request,
          { op: "upload_failed", fileName, code: err.code, message: err.message },
          err.statusCode === 403 ? "rejected" : "error",
        );
      }
      return sendPluginError(reply, err);
    }
  });

  app.patch("/api/admin/datasource-plugins/:driverId", { preHandler }, async (request, reply) => {
    const params = driverIdParamsSchema.safeParse(request.params);
    const body = toggleBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: { code: "VALIDATION_ERROR", message: "请求参数无效" },
      });
    }
    try {
      const plugin = await setDatasourcePluginEnabled({
        db,
        config,
        drivers,
        pools,
        driverId: params.data.driverId,
        enabled: body.data.enabled,
      });
      audit(request, {
        op: body.data.enabled ? "enable" : "disable",
        driverId: plugin.id,
        enabled: body.data.enabled,
      });
      return { plugin };
    } catch (err) {
      return sendPluginError(reply, err);
    }
  });

  app.delete("/api/admin/datasource-plugins/:driverId", { preHandler }, async (request, reply) => {
    const params = driverIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({
        error: { code: "VALIDATION_ERROR", message: "驱动标识格式无效" },
      });
    }
    try {
      const result = await deleteDatasourcePlugin({
        db,
        config,
        drivers,
        pools,
        driverId: params.data.driverId,
      });
      audit(request, { op: "delete", driverId: params.data.driverId });
      return result;
    } catch (err) {
      return sendPluginError(reply, err);
    }
  });
}
