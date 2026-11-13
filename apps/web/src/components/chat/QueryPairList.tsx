import type { ChatResult, ChatSql } from "../../lib/api";
import { ResultCard } from "./ResultCard";
import { SqlCard } from "./SqlCard";

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/**
 * Keeps each executed SQL next to the rows it produced: SQL on top, result below.
 * Failed or rejected statements have no result and stay on their own.
 */
export function QueryPairList({
  sqls,
  results,
  onCreateReport,
  canExport = true,
}: {
  sqls: ChatSql[];
  results: ChatResult[];
  onCreateReport?: (artifactId: string) => void;
  canExport?: boolean;
}) {
  const unmatched = [...results];
  const pairs = sqls.map((sql) => {
    const index = unmatched.findIndex(
      (result) => result.sql !== undefined && normalize(result.sql) === normalize(sql.sql),
    );
    const result = index >= 0 ? unmatched.splice(index, 1)[0] : undefined;
    return { sql, result };
  });

  if (pairs.length === 0 && unmatched.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {pairs.map(({ sql, result }) => (
        <div
          key={sql.auditId}
          className="overflow-hidden rounded-md border border-line bg-surface"
        >
          <SqlCard sql={sql} flat />
          {result ? (
            <div className="border-t border-line">
              <ResultCard
                {...result}
                sql={undefined}
                flat
                onCreateReport={onCreateReport}
                canExport={canExport}
              />
            </div>
          ) : null}
        </div>
      ))}
      {unmatched.map((result, index) => (
        <ResultCard
          key={result.artifactId}
          {...result}
          flat
          index={unmatched.length > 1 ? index + 1 : undefined}
          onCreateReport={onCreateReport}
          canExport={canExport}
        />
      ))}
    </div>
  );
}
