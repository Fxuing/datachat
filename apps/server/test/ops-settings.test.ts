import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { effectiveSettings, saveSettings } from "../src/services/app-settings.js";
import { testConfig } from "./helpers/config.js";

describe("retention settings", () => {
  it("defaults to disabled and persists overrides", () => {
    const handle = createDb(":memory:");
    migrateDb(handle.db);

    expect(effectiveSettings(handle.db, testConfig).retentionConversationDays).toBe(0);
    expect(effectiveSettings(handle.db, testConfig).retentionAuditDays).toBe(0);

    saveSettings(handle.db, {
      retentionConversationDays: 90,
      retentionAuditDays: 180,
    });
    const saved = effectiveSettings(handle.db, testConfig);
    expect(saved.retentionConversationDays).toBe(90);
    expect(saved.retentionAuditDays).toBe(180);

    saveSettings(handle.db, { retentionConversationDays: null });
    expect(effectiveSettings(handle.db, testConfig).retentionConversationDays).toBe(0);
    handle.sqlite.close();
  });
});
