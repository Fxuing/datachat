import { z } from "zod";

/**
 * Result/chart column metadata shared by the tool layer (Plan 1 `ColumnInfo`) and
 * the browser, so event payloads and artifact JSON use one vocabulary.
 */
export const columnTypeSchema = z.enum(["number", "string", "boolean", "date", "json", "unknown"]);
export type ColumnType = z.infer<typeof columnTypeSchema>;

export const columnSchema = z.object({
  name: z.string(),
  type: columnTypeSchema,
});
export type Column = z.infer<typeof columnSchema>;

export const EXCEL_MAX_SHEETS = 10;
export const EXCEL_MAX_FILENAME_LENGTH = 100;
export const EXCEL_MAX_SHEET_NAME_LENGTH = 31;

export const excelSheetSpecSchema = z.object({
  name: z.string(),
  artifactId: z.string(),
  rowCount: z.number().int().nonnegative(),
});
export type ExcelSheetSpec = z.infer<typeof excelSheetSpecSchema>;

export const excelWorkbookSpecSchema = z.object({
  filename: z.string(),
  sheets: z.array(excelSheetSpecSchema).min(1).max(EXCEL_MAX_SHEETS),
  totalRows: z.number().int().nonnegative(),
});
export type ExcelWorkbookSpec = z.infer<typeof excelWorkbookSpecSchema>;

/**
 * Stream event model (spec §5.7). One event per run_events row; the server adds
 * `seq` when persisting (spec: `RunEvent & { seq: number }`), so it is not part of
 * this union. `assistant_message` is the history-aggregation event persisted when
 * a run finishes.
 */
/** One memory the agent was given for a turn. */
export const runMemorySchema = z.object({
  id: z.string(),
  kind: z.enum(["profile", "instruction", "preference", "fact"]),
  /** The memory text as it was injected; already capped by the recall budget. */
  content: z.string(),
  /** Always-on core memory, rather than one recalled for this question. */
  core: z.boolean(),
  /** Human label for the scope ("全局" or the datasource name), when known. */
  scope: z.string().optional(),
});

export type RunMemory = z.infer<typeof runMemorySchema>;

export const runEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("run_queued"),
    payload: z.object({ position: z.number().int().min(1) }),
  }),
  z.object({
    type: z.literal("run_start"),
    payload: z.object({ startedAt: z.number().int() }),
  }),
  z.object({
    type: z.literal("user_message"),
    payload: z.object({ content: z.string(), skill: z.string().optional() }),
  }),
  z.object({
    type: z.literal("assistant_message"),
    payload: z.object({ content: z.string() }),
  }),
  z.object({
    type: z.literal("text_delta"),
    payload: z.object({ text: z.string() }),
  }),
  z.object({
    type: z.literal("thinking_delta"),
    payload: z.object({ text: z.string() }),
  }),
  /** Final thinking transcript, persisted once per run for reloaded histories. */
  z.object({
    type: z.literal("thinking"),
    payload: z.object({
      content: z.string(),
      /** The same text split where a tool call interrupted the reasoning.
       *
       * Absent on rows written before the split existed; readers fall back to
       * treating `content` as one segment. */
      segments: z.array(z.string()).optional(),
    }),
  }),
  /** Memories the memory extension put into this turn's system prompt. */
  z.object({
    type: z.literal("memory_used"),
    payload: z.object({ memories: z.array(runMemorySchema) }),
  }),
  z.object({
    type: z.literal("tool_start"),
    payload: z.object({
      toolCallId: z.string(),
      name: z.string(),
      args: z.unknown(),
    }),
  }),
  z.object({
    type: z.literal("tool_end"),
    payload: z.object({
      toolCallId: z.string(),
      name: z.string(),
      isError: z.boolean(),
      durationMs: z.number().int().nonnegative(),
      summary: z.string(),
      url: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("question"),
    payload: z.object({
      toolCallId: z.string(),
      questions: z.array(
        z.object({
          question: z.string(),
          header: z.string(),
          multiSelect: z.boolean(),
          options: z.array(
            z.object({
              label: z.string(),
              description: z.string(),
              hasPreview: z.boolean().default(false),
            }),
          ),
        }),
      ),
    }),
  }),
  z.object({
    type: z.literal("question_resolved"),
    payload: z.object({
      toolCallId: z.string(),
      ok: z.boolean(),
      code: z.string().optional(),
      reason: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("context_usage"),
    payload: z.object({
      tokens: z.number().int().nonnegative().nullable(),
      contextWindow: z.number().int().positive(),
      percent: z.number().min(0).max(100).nullable(),
    }),
  }),
  z.object({
    type: z.literal("sql"),
    payload: z.object({
      sql: z.string(),
      auditId: z.string(),
      status: z.enum(["ok", "rejected", "error"]),
    }),
  }),
  z.object({
    type: z.literal("result"),
    payload: z.object({
      artifactId: z.string(),
      columns: z.array(columnSchema),
      rows: z.array(z.array(z.unknown())),
      rowCount: z.number().int().nonnegative(),
      truncated: z.boolean(),
      /** The guarded statement that produced this result, for UI context. */
      sql: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("chart"),
    payload: z.object({
      chartArtifactId: z.string(),
      // ECharts option; kept as a JSON object because shared does not depend on echarts.
      spec: z.record(z.unknown()),
      points: z.number().int().nonnegative(),
      title: z.string(),
    }),
  }),
  z.object({
    type: z.literal("excel"),
    payload: z.object({
      excelArtifactId: z.string(),
      filename: z.string(),
      sheets: z.array(excelSheetSpecSchema),
      totalRows: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    type: z.literal("report"),
    payload: z.object({ reportId: z.string(), title: z.string() }),
  }),
  z.object({
    type: z.literal("retry"),
    payload: z.object({
      attempt: z.number().int().min(1),
      delayMs: z.number().int().nonnegative(),
      message: z.string(),
    }),
  }),
  z.object({
    type: z.literal("compaction"),
    payload: z.object({
      reason: z.string(),
      tokensBefore: z.number().int().nonnegative().optional(),
      tokensAfter: z.number().int().nonnegative().optional(),
    }),
  }),
  z.object({
    type: z.literal("usage"),
    payload: z.object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      cacheRead: z.number().int().nonnegative(),
      cacheWrite: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    type: z.literal("run_end"),
    payload: z.object({
      status: z.enum(["ok", "error", "aborted"]),
      error: z.string().optional(),
    }),
  }),
]);
export type RunEvent = z.infer<typeof runEventSchema>;
export type RunEventType = RunEvent["type"];
