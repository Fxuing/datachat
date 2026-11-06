import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const validSecret = "test-secret-test-secret-test-secret-32";

describe("loadConfig", () => {
  it("defaults an empty PORT to 8080", () => {
    const config = loadConfig({ APP_SECRET: validSecret, PORT: "" });
    expect(config.port).toBe(8080);
  });

  it("rejects an out-of-range PORT", () => {
    expect(() => loadConfig({ APP_SECRET: validSecret, PORT: "70000" })).toThrow(/PORT/);
  });

  it("rejects an unknown LOG_LEVEL", () => {
    expect(() => loadConfig({ APP_SECRET: validSecret, LOG_LEVEL: "verbose" })).toThrow(
      /LOG_LEVEL/,
    );
  });

  it("rejects the placeholder APP_SECRET", () => {
    expect(() =>
      loadConfig({ APP_SECRET: "replace-with-at-least-32-random-characters" }),
    ).toThrow("APP_SECRET must be a real random secret");
  });

  it("trims ADMIN_USERNAME and applies its length bounds", () => {
    expect(loadConfig({ APP_SECRET: validSecret, ADMIN_USERNAME: "  admin  " }).adminUsername).toBe(
      "admin",
    );
    expect(() => loadConfig({ APP_SECRET: validSecret, ADMIN_USERNAME: "a" })).toThrow(
      /ADMIN_USERNAME/,
    );
    expect(() =>
      loadConfig({ APP_SECRET: validSecret, ADMIN_USERNAME: "a".repeat(65) }),
    ).toThrow(/ADMIN_USERNAME/);
  });

  it("rejects an ADMIN_PASSWORD longer than 200 characters", () => {
    expect(() =>
      loadConfig({ APP_SECRET: validSecret, ADMIN_PASSWORD: "x".repeat(201) }),
    ).toThrow(/ADMIN_PASSWORD/);
  });

  it("treats an empty ADMIN_PASSWORD as unset", () => {
    const config = loadConfig({ APP_SECRET: validSecret, ADMIN_PASSWORD: "" });
    expect(config.adminPassword).toBeUndefined();
  });

  it("resolves a relative DATA_DIR against the repo root", () => {
    const config = loadConfig({ APP_SECRET: validSecret, DATA_DIR: "./data" });
    expect(path.isAbsolute(config.dataDir)).toBe(true);
    expect(path.basename(config.dataDir)).toBe("data");
    expect(config.dataDir).toBe(path.resolve(import.meta.dirname, "../../../data"));
  });

  it("parses a minimal valid env", () => {
    const config = loadConfig({ APP_SECRET: validSecret });
    expect(config).toMatchObject({
      port: 8080,
      appSecret: validSecret,
      logLevel: "info",
      adminUsername: "admin",
      isProduction: false,
    });
    expect(config.dbPath).toBe(path.join(config.dataDir, "datachat.db"));
  });
});
