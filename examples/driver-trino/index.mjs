/**
 * Minimal Trino HTTP datasource driver plugin for DataChat.
 *
 * Speaks Trino's `/v1/statement` REST protocol using Node's built-in `fetch`
 * with zero third-party dependencies. Can be uploaded directly as a single
 * `.mjs` file in Admin -> Datasources -> Driver Plugins.
 *
 * Usage:
 *   - Web UI: Upload this file in 管理 -> 数据源 -> 驱动插件
 *   - Env:    DATASOURCE_PLUGINS=./examples/driver-trino/index.mjs
 */

const SDK_VERSION = 1;

function normalizeTrinoType(raw) {
  const lower = String(raw ?? "").toLowerCase();
  if (/int|bigint|smallint|tinyint|double|real|decimal|numeric/.test(lower)) return "number";
  if (/bool/.test(lower)) return "boolean";
  if (/date|time|timestamp|interval/.test(lower)) return "date";
  if (/json|map|row|array/.test(lower)) return "json";
  if (/varchar|char|uuid|varbinary|ipaddress/.test(lower)) return "string";
  return "unknown";
}

function buildBaseUrl(config) {
  const protocol =
    config.options?.protocol === "https" || config.sslMode !== "disable" ? "https" : "http";
  return `${protocol}://${config.host}:${config.port}`;
}

function buildHeaders(config) {
  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Trino-User": config.username || "datachat",
    "X-Trino-Source": "datachat",
    "X-Trino-Catalog": String(config.options?.catalog ?? "hive"),
    "X-Trino-Schema": config.database,
  };
  if (typeof config.options?.apiToken === "string" && config.options.apiToken.length > 0) {
    headers.Authorization = `Bearer ${config.options.apiToken}`;
  } else if (config.password) {
    const basic = Buffer.from(`${config.username}:${config.password}`, "utf8").toString("base64");
    headers.Authorization = `Basic ${basic}`;
  }
  return headers;
}

async function runTrinoStatement(config, sql, { timeoutMs = 30_000, signal, onPage } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Trino 查询超时")),
    Math.max(1_000, timeoutMs),
  );
  const onAbort = () => controller.abort(signal?.reason ?? new Error("已取消"));
  signal?.addEventListener("abort", onAbort, { once: true });

  let nextUri = `${buildBaseUrl(config)}/v1/statement`;
  let method = "POST";
  let body = sql.trim().replace(/;+\s*$/, "");
  let columns = [];
  let collected = [];

  try {
    while (nextUri) {
      if (controller.signal.aborted) break;
      const res = await fetch(nextUri, {
        method,
        headers: buildHeaders(config),
        ...(method === "POST" ? { body } : {}),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        throw new Error(`Trino HTTP ${res.status}: ${detail || res.statusText}`);
      }
      const payload = await res.json();
      if (payload?.error) {
        throw new Error(
          `Trino ${payload.error.errorName ?? "ERROR"}: ${payload.error.message ?? "查询失败"}`,
        );
      }
      if (columns.length === 0 && Array.isArray(payload?.columns)) {
        columns = payload.columns.map((col) => ({
          name: String(col.name),
          type: normalizeTrinoType(col.type),
        }));
      }
      if (Array.isArray(payload?.data) && payload.data.length > 0) {
        if (onPage) {
          await onPage(columns, payload.data);
        } else {
          collected = collected.concat(payload.data);
        }
      }
      nextUri = typeof payload?.nextUri === "string" ? payload.nextUri : "";
      method = "GET";
      body = undefined;
    }
    return { columns, rows: collected };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function escapeSqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const trinoDriver = {
  manifest: {
    sdkVersion: SDK_VERSION,
    id: "trino",
    label: "Trino",
    connectionMode: "network",
    defaultPort: 8080,
    supportsSsl: true,
    optionsSchema: [
      {
        key: "catalog",
        label: "Catalog 名称",
        type: "text",
        required: true,
        defaultValue: "hive",
        placeholder: "例如 hive / iceberg / tpch",
        description: "Trino 联邦目录名；数据库字段填写对应的 Schema 名称。",
      },
      {
        key: "protocol",
        label: "传输协议",
        type: "select",
        defaultValue: "http",
        options: [
          { value: "http", label: "HTTP" },
          { value: "https", label: "HTTPS" },
        ],
      },
      {
        key: "apiToken",
        label: "Bearer 访问令牌（可选）",
        type: "text",
        secret: true,
        placeholder: "配置 JWT / OAuth2 令牌时填写；留空则使用 Basic Auth",
      },
    ],
    capabilities: {
      explain: true,
      readOnlyProbe: false,
      rowScope: false,
    },
  },

  dialect: {
    parserDialect: "postgresql",
    placeholderStyle: "qmark",
    quoteChar: '"',
    extraForbiddenFunctions: ["system"],
    extraSystemSchemas: ["system"],
    promptGuidance:
      "Trino 使用 ANSI SQL（双引号引用标识符）；日期截取请使用 date_trunc('month', col)，字符串拼接使用 concat() 或 ||；禁止访问 system 或跨 catalog 系统表。",
  },

  async probe(config, opts) {
    try {
      const infoUrl = `${buildBaseUrl(config)}/v1/info`;
      let serverVersion;
      try {
        const infoRes = await fetch(infoUrl, { signal: AbortSignal.timeout(3_000) });
        if (infoRes.ok) {
          const info = await infoRes.json();
          serverVersion = info?.nodeVersion?.version
            ? String(info.nodeVersion.version)
            : undefined;
        }
      } catch {
        // `/v1/info` may be restricted behind proxies; fall through to SELECT 1.
      }
      await runTrinoStatement(config, "SELECT 1 AS ok", {
        timeoutMs: opts?.timeoutMs ?? 8_000,
      });
      return {
        ok: true,
        serverVersion,
        readOnly: false,
        warnings: [
          "Trino HTTP 驱动无法直接探测服务端 ACL 只读权限，请确保 Trino 账号在对应 Catalog 仅授予 SELECT 权限。",
        ],
      };
    } catch (err) {
      return {
        ok: false,
        readOnly: false,
        warnings: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  createPool(config) {
    return {
      async introspect() {
        const schemaLiteral = escapeSqlLiteral(config.database);
        const tablesRes = await runTrinoStatement(
          config,
          `SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = ${schemaLiteral} ORDER BY table_name LIMIT 500`,
        );
        const colsRes = await runTrinoStatement(
          config,
          `SELECT table_name, column_name, data_type, is_nullable, column_default, comment FROM information_schema.columns WHERE table_schema = ${schemaLiteral} ORDER BY table_name, ordinal_position`,
        );

        const colsByTable = new Map();
        for (const row of colsRes.rows) {
          const [table, name, type, isNullable, defaultVal, comment] = row;
          const list = colsByTable.get(table) ?? [];
          list.push({
            name: String(name),
            type: String(type),
            nullable: String(isNullable).toUpperCase() === "YES",
            defaultValue: defaultVal == null ? null : String(defaultVal),
            comment: comment == null ? null : String(comment),
          });
          colsByTable.set(table, list);
        }

        const tables = tablesRes.rows.map(([schema, name]) => ({
          schema: String(schema),
          name: String(name),
          comment: null,
          rowEstimate: null,
          columns: colsByTable.get(name) ?? [],
          primaryKey: [],
          indexes: [],
          foreignKeys: [],
        }));

        return { tables, refreshedAt: Date.now() };
      },

      async executeQuery(req, emitBatch) {
        const batchSize = Math.max(1, req.batchSize || 200);
        await runTrinoStatement(config, req.sql, {
          timeoutMs: req.timeoutMs,
          signal: req.signal,
          onPage: async (columns, rows) => {
            for (let i = 0; i < rows.length; i += batchSize) {
              if (req.signal?.aborted) break;
              await emitBatch({ columns, rows: rows.slice(i, i + batchSize) });
            }
          },
        });
      },

      async close() {
        // HTTP transport is stateless.
      },
    };
  },
};

export default trinoDriver;
