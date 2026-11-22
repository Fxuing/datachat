/**
 * Minimal ClickHouse HTTP datasource driver plugin for DataChat.
 *
 * Uses Node's built-in `fetch` against ClickHouse's HTTP interface with
 * `readonly=1` enforced on every request and zero third-party dependencies.
 *
 * Usage:
 *   DATASOURCE_PLUGINS=./examples/driver-clickhouse/index.mjs
 */

const SDK_VERSION = 1;

function normalizeClickHouseType(raw) {
  const lower = String(raw ?? "").toLowerCase();
  if (/int|float|decimal|double|numeric/.test(lower)) return "number";
  if (/bool/.test(lower)) return "boolean";
  if (/date|time/.test(lower)) return "date";
  if (/json|map|tuple|array|object/.test(lower)) return "json";
  if (/string|uuid|enum|fixedstring|ipv4|ipv6/.test(lower)) return "string";
  return "unknown";
}

function buildEndpoint(config, extraParams = {}) {
  const protocol = config.options?.protocol === "https" || config.sslMode !== "disable" ? "https" : "http";
  const url = new URL(`${protocol}://${config.host}:${config.port}/`);
  url.searchParams.set("database", config.database);
  url.searchParams.set("readonly", String(config.options?.readonlyLevel ?? "1"));
  for (const [k, v] of Object.entries(extraParams)) {
    url.searchParams.set(k, String(v));
  }
  return url;
}

function buildHeaders(config) {
  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
    "X-ClickHouse-User": config.username,
    "X-ClickHouse-Key": config.password,
  };
  if (typeof config.options?.apiToken === "string" && config.options.apiToken.length > 0) {
    headers.Authorization = `Bearer ${config.options.apiToken}`;
  }
  return headers;
}

async function runHttpQuery(config, sql, { timeoutMs = 15_000, signal, extraParams = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("查询超时")), Math.max(1_000, timeoutMs));
  const onAbort = () => controller.abort(signal?.reason ?? new Error("已取消"));
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const body = `${sql.trim().replace(/;+\s*$/, "")}\nFORMAT JSONCompact`;
    const response = await fetch(buildEndpoint(config, extraParams), {
      method: "POST",
      headers: buildHeaders(config),
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(`ClickHouse HTTP ${response.status}: ${detail || response.statusText}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

const clickhouseDriver = {
  manifest: {
    sdkVersion: SDK_VERSION,
    id: "clickhouse",
    label: "ClickHouse",
    connectionMode: "network",
    defaultPort: 8123,
    supportsSsl: true,
    optionsSchema: [
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
        key: "readonlyLevel",
        label: "只读模式级别",
        type: "select",
        defaultValue: "1",
        description: "ClickHouse readonly=1 禁止写操作和修改会话设置；readonly=2 允许修改只读设置。",
        options: [
          { value: "1", label: "readonly=1（严格只读）" },
          { value: "2", label: "readonly=2（允许查询级设置）" },
        ],
      },
      {
        key: "apiToken",
        label: "网关访问令牌（可选）",
        type: "text",
        secret: true,
        placeholder: "如经反向代理鉴权可填写 Bearer Token",
      },
    ],
    capabilities: {
      explain: false,
      readOnlyProbe: false,
      rowScope: false,
    },
  },

  dialect: {
    parserDialect: "mysql",
    placeholderStyle: "qmark",
    quoteChar: "`",
    extraForbiddenFunctions: [
      "url",
      "remote",
      "remotesecure",
      "s3",
      "s3cluster",
      "hdfs",
      "file",
      "mysql",
      "postgresql",
      "jdbc",
      "odbc",
      "input",
      "cluster",
      "clusterallreplicas",
    ],
    extraSystemSchemas: ["system"],
    promptGuidance:
      "ClickHouse 表名和列名区分大小写；日期聚合优先使用 toDate()/toStartOfMonth()；严禁调用外部表函数（url/s3/remote/file 等）。",
  },

  async probe(config, opts) {
    try {
      const payload = await runHttpQuery(config, "SELECT version()", {
        timeoutMs: opts?.timeoutMs ?? 8_000,
      });
      const version = String(payload?.data?.[0]?.[0] ?? "").trim() || undefined;
      return {
        ok: true,
        serverVersion: version,
        readOnly: false,
        warnings: [
          "ClickHouse HTTP 驱动已在请求层强制附加 readonly 参数，但无法直接校验服务端账号权限，请仍使用只读账号。",
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
        const tablesRes = await runHttpQuery(
          config,
          "SELECT database, name, comment, total_rows FROM system.tables WHERE database = {db:String} AND is_temporary = 0 ORDER BY name LIMIT 500",
          { extraParams: { param_db: config.database } },
        );
        const colsRes = await runHttpQuery(
          config,
          "SELECT table, name, type, default_expression, comment, is_in_primary_key FROM system.columns WHERE database = {db:String} ORDER BY table, position",
          { extraParams: { param_db: config.database } },
        );

        const colsByTable = new Map();
        const pkByTable = new Map();
        for (const row of colsRes?.data ?? []) {
          const [table, name, type, defaultExpr, comment, isPk] = row;
          const list = colsByTable.get(table) ?? [];
          list.push({
            name: String(name),
            type: String(type),
            nullable: String(type).startsWith("Nullable("),
            defaultValue: defaultExpr ? String(defaultExpr) : null,
            comment: comment ? String(comment) : null,
          });
          colsByTable.set(table, list);
          if (Number(isPk) === 1) {
            const pks = pkByTable.get(table) ?? [];
            pks.push(String(name));
            pkByTable.set(table, pks);
          }
        }

        const tables = (tablesRes?.data ?? []).map(([schema, name, comment, totalRows]) => ({
          schema: String(schema),
          name: String(name),
          comment: comment ? String(comment) : null,
          rowEstimate: totalRows == null ? null : Number(totalRows),
          columns: colsByTable.get(name) ?? [],
          primaryKey: pkByTable.get(name) ?? [],
          indexes: [],
          foreignKeys: [],
        }));

        return { tables, refreshedAt: Date.now() };
      },

      async executeQuery(req, emitBatch) {
        const payload = await runHttpQuery(config, req.sql, {
          timeoutMs: req.timeoutMs,
          signal: req.signal,
          extraParams: {
            max_execution_time: Math.max(1, Math.ceil(req.timeoutMs / 1000)),
          },
        });
        const columns = (payload?.meta ?? []).map((col) => ({
          name: String(col.name),
          type: normalizeClickHouseType(col.type),
        }));
        const rows = Array.isArray(payload?.data) ? payload.data : [];
        const batchSize = Math.max(1, req.batchSize || 200);
        for (let i = 0; i < rows.length; i += batchSize) {
          if (req.signal?.aborted) break;
          await emitBatch({ columns, rows: rows.slice(i, i + batchSize) });
        }
      },

      async close() {
        // HTTP transport is stateless; nothing to close.
      },
    };
  },
};

export default clickhouseDriver;
