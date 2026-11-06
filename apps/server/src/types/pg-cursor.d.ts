declare module "pg-cursor" {
  import type { QueryResult } from "pg";

  export interface CursorQueryConfig {
    rowMode?: "array";
    types?: unknown;
  }

  export default class Cursor<Row = unknown> {
    constructor(text: string, values?: unknown[], config?: CursorQueryConfig);
    read(
      rowCount: number,
      callback: (error: Error | null, rows: Row[], result: QueryResult) => void,
    ): void;
    close(): Promise<void>;
  }
}
