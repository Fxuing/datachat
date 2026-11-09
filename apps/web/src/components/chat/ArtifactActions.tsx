import { useState } from "react";
import { Download } from "lucide-react";
import { ApiError, getArtifactRows } from "../../lib/api";
import { Button } from "../ui/button";

export const LOAD_MORE_LIMIT = 100;

export type ArtifactDownloadFormat = "csv" | "xlsx";

/** Same-origin link so the session cookie rides along with the download. */
export function artifactDownloadUrl(
  artifactId: string,
  format: ArtifactDownloadFormat,
): string {
  return `/api/artifacts/${artifactId}/download?format=${format}`;
}

export interface ArtifactActionsProps {
  artifactId: string;
  rowCount: number;
  /** Rows already rendered; the next page starts at this offset. */
  shownRows: number;
  /** When provided, a “加载更多” button pages rows until `rowCount` is reached. */
  onRowsAppended?: (rows: unknown[][]) => void;
}

export function ArtifactActions({
  artifactId,
  rowCount,
  shownRows,
  onRowsAppended,
}: ArtifactActionsProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);

  // `shownRows` is owned by the table and already includes appended pages, so it
  // doubles as the next offset.
  const canLoadMore = Boolean(onRowsAppended) && !exhausted && shownRows < rowCount;

  const loadMore = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const page = await getArtifactRows(artifactId, {
        offset: shownRows,
        limit: LOAD_MORE_LIMIT,
      });
      if (page.rows.length === 0) {
        setExhausted(true);
      } else {
        onRowsAppended?.(page.rows);
      }
    } catch (loadError) {
      setError(
        loadError instanceof ApiError ? loadError.message : "加载更多失败，请稍后重试",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <a
        href={artifactDownloadUrl(artifactId, "csv")}
        download
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-linestrong bg-surface px-3 text-xs font-medium text-inksoft transition-colors hover:bg-subtle"
      >
        <Download className="h-3.5 w-3.5" />
        下载 CSV
      </a>
      <a
        href={artifactDownloadUrl(artifactId, "xlsx")}
        download
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-linestrong bg-surface px-3 text-xs font-medium text-inksoft transition-colors hover:bg-subtle"
      >
        <Download className="h-3.5 w-3.5" />
        下载 Excel
      </a>
      {canLoadMore ? (
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void loadMore()}>
          {loading ? "加载中…" : "加载更多"}
        </Button>
      ) : null}
      {error ? (
        <span role="alert" className="text-[11px] text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}
