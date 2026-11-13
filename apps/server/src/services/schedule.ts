import { CronExpressionParser } from "cron-parser";

export const MIN_SCHEDULE_INTERVAL_MS = 5 * 60_000;

export interface ScheduleError {
  code: "INVALID_CRON" | "INVALID_TIMEZONE" | "TOO_FREQUENT";
  message: string;
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function validateSchedule(input: {
  cronExpression: string;
  timezone: string;
}): ScheduleError | null {
  const expression = input.cronExpression.trim();
  const timezone = input.timezone.trim();
  if (expression.split(/\s+/).length !== 5) {
    return { code: "INVALID_CRON", message: "cron 表达式无效，请使用 5 段格式" };
  }
  if (!timezone || !isValidTimezone(timezone)) {
    return { code: "INVALID_TIMEZONE", message: "时区无效，请使用 IANA 时区，例如 Asia/Shanghai" };
  }
  let first: number;
  let second: number;
  try {
    const interval = CronExpressionParser.parse(expression, {
      tz: timezone,
      currentDate: new Date(),
    });
    first = interval.next().getTime();
    second = interval.next().getTime();
  } catch {
    return { code: "INVALID_CRON", message: "cron 表达式无效，请使用 5 段格式" };
  }
  if (second - first < MIN_SCHEDULE_INTERVAL_MS) {
    return { code: "TOO_FREQUENT", message: "执行间隔不能小于 5 分钟" };
  }
  return null;
}

export function nextScheduleRun(input: {
  cronExpression: string;
  timezone: string;
  from?: number;
}): number {
  const interval = CronExpressionParser.parse(input.cronExpression.trim(), {
    tz: input.timezone.trim(),
    currentDate: new Date(input.from ?? Date.now()),
  });
  return interval.next().getTime();
}

export function describeSchedule(cronExpression: string): string {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) return cronExpression;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const time = `${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")}`;
  if (month === "*" && dayOfMonth === "*" && dayOfWeek === "*") {
    return `每天 ${time}`;
  }
  if (month === "*" && dayOfMonth === "*" && dayOfWeek === "1") {
    return `每周一 ${time}`;
  }
  if (month === "*" && dayOfMonth === "1" && dayOfWeek === "*") {
    return `每月 1 日 ${time}`;
  }
  return cronExpression;
}
