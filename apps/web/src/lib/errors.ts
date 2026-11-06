import { ApiError } from "./api";

interface ValidationDetails {
  fieldErrors?: Record<string, string[]>;
  formErrors?: string[];
}

/**
 * Turn the API error envelope into a single inline message. The machine code is
 * kept in the text so datasource failures (`DS_UNREACHABLE`, `CONFLICT`, ...)
 * stay identifiable without exposing anything from the request body.
 */
export function describeApiError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  const details = error.details as ValidationDetails | string | undefined;
  if (typeof details === "string") return `${error.code}：${error.message}（${details}）`;
  const lines: string[] = [];
  if (details?.fieldErrors) {
    for (const messages of Object.values(details.fieldErrors)) {
      if (Array.isArray(messages)) lines.push(...messages);
    }
  }
  if (Array.isArray(details?.formErrors)) lines.push(...details.formErrors);
  const base = `${error.code}：${error.message}`;
  return lines.length ? `${base}；${lines.join("；")}` : base;
}
