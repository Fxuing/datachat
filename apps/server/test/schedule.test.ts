import { describe, expect, it } from "vitest";
import {
  describeSchedule,
  MIN_SCHEDULE_INTERVAL_MS,
  nextScheduleRun,
  validateSchedule,
} from "../src/services/schedule.js";

describe("schedule validation", () => {
  it("accepts daily and weekly presets", () => {
    expect(validateSchedule({ cronExpression: "0 9 * * *", timezone: "Asia/Shanghai" })).toBeNull();
    expect(validateSchedule({ cronExpression: "30 8 * * 1", timezone: "UTC" })).toBeNull();
  });

  it("rejects invalid cron expressions", () => {
    expect(validateSchedule({ cronExpression: "not a cron", timezone: "UTC" })?.code).toBe(
      "INVALID_CRON",
    );
    expect(validateSchedule({ cronExpression: "0 9 * *", timezone: "UTC" })?.code).toBe(
      "INVALID_CRON",
    );
  });

  it("rejects invalid timezones", () => {
    expect(validateSchedule({ cronExpression: "0 9 * * *", timezone: "Mars/Base" })?.code).toBe(
      "INVALID_TIMEZONE",
    );
    expect(validateSchedule({ cronExpression: "0 9 * * *", timezone: "" })?.code).toBe(
      "INVALID_TIMEZONE",
    );
  });

  it("rejects schedules more frequent than five minutes", () => {
    const error = validateSchedule({ cronExpression: "* * * * *", timezone: "UTC" });
    expect(error?.code).toBe("TOO_FREQUENT");
    expect(error?.message).toContain("5 分钟");
    expect(MIN_SCHEDULE_INTERVAL_MS).toBe(300_000);
  });

  it("computes the next run in the task timezone", () => {
    const from = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(
      nextScheduleRun({ cronExpression: "0 9 * * *", timezone: "Asia/Shanghai", from }),
    ).toBe(Date.UTC(2026, 0, 1, 1, 0, 0));
    expect(
      nextScheduleRun({ cronExpression: "0 9 * * *", timezone: "America/New_York", from }),
    ).toBe(Date.UTC(2026, 0, 1, 14, 0, 0));
  });

  it("describes supported presets and leaves custom expressions alone", () => {
    expect(describeSchedule("0 9 * * *")).toBe("每天 09:00");
    expect(describeSchedule("30 8 * * 1")).toBe("每周一 08:30");
    expect(describeSchedule("0 7 1 * *")).toBe("每月 1 日 07:00");
    expect(describeSchedule("15 6 * * 3")).toBe("15 6 * * 3");
  });
});
