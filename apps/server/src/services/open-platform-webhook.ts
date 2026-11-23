import { createHmac } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { decryptSecret, deriveSecretKey } from "../agent/datasource/crypto.js";
import {
  createWebhookDelivery,
  findOpenApp,
  findWebhookDelivery,
  updateWebhookDelivery,
  type OpenAppRow,
  type OpenWebhookDeliveryRow,
} from "../db/repositories/open-platform.js";

export type OpenWebhookEvent =
  | "ask.completed"
  | "ask.failed"
  | "report.completed"
  | "report.failed";

export interface OpenWebhookServiceOptions {
  db: Db;
  config: AppConfig;
  fetchImpl?: typeof fetch;
  /** Retry delays in ms; tests can pass `[10, 20]` for speed. */
  retryDelaysMs?: number[];
  timeoutMs?: number;
}

export function signWebhookPayload(secret: string, timestampSec: number, rawBody: string): string {
  const digest = createHmac("sha256", secret)
    .update(`${timestampSec}.${rawBody}`)
    .digest("hex");
  return `t=${timestampSec},v1=${digest}`;
}

export function validateWebhookUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "Webhook URL 仅支持 http:// 或 https:// 协议";
    }
    return null;
  } catch {
    return "Webhook URL 格式不正确";
  }
}

export class OpenWebhookService {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelaysMs: number[];
  private readonly timeoutMs: number;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private closed = false;

  constructor(options: OpenWebhookServiceOptions) {
    this.db = options.db;
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryDelaysMs = options.retryDelaysMs ?? [1_000, 5_000];
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** Creates a delivery record and schedules outbound delivery in the background. */
  dispatch(input: {
    app: OpenAppRow;
    event: OpenWebhookEvent;
    payload: unknown;
  }): OpenWebhookDeliveryRow | null {
    if (this.closed || !input.app.webhookUrl) return null;
    const body = JSON.stringify({
      event: input.event,
      appId: input.app.id,
      timestamp: Date.now(),
      data: input.payload,
    });
    const record = createWebhookDelivery(this.db, {
      appId: input.app.id,
      event: input.event,
      targetUrl: input.app.webhookUrl,
      payloadJson: body,
    });
    const task = this.deliverWithRetries(record.id, input.app);
    this.track(task);
    return record;
  }

  /** Re-attempts an existing delivery immediately (called from Admin replay). */
  async replay(deliveryId: string): Promise<OpenWebhookDeliveryRow> {
    const record = findWebhookDelivery(this.db, deliveryId);
    if (!record) {
      throw new Error("Webhook 投递记录不存在");
    }
    const app = findOpenApp(this.db, record.appId);
    if (!app) {
      throw new Error("关联的开放应用不存在");
    }
    return this.attemptOnce(record, app);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    await Promise.allSettled([...this.inFlight]);
  }

  private track(promise: Promise<unknown>): void {
    this.inFlight.add(promise);
    void promise.finally(() => {
      this.inFlight.delete(promise);
    });
  }

  private resolveSecret(app: OpenAppRow): string | null {
    if (!app.webhookSecretCipher) return null;
    try {
      const key = deriveSecretKey(this.config.appSecret);
      return decryptSecret(app.webhookSecretCipher, key);
    } catch {
      return null;
    }
  }

  private async deliverWithRetries(deliveryId: string, app: OpenAppRow): Promise<void> {
    let record = findWebhookDelivery(this.db, deliveryId);
    if (!record) return;
    const maxAttempts = 1 + this.retryDelaysMs.length;
    for (let i = 0; i < maxAttempts; i += 1) {
      if (this.closed) return;
      record = await this.attemptOnce(record, app);
      if (record.status === "ok") return;
      const delay = this.retryDelaysMs[i];
      if (delay === undefined || this.closed) return;
      await this.sleep(delay);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, ms);
      timer.unref?.();
      this.timers.add(timer);
    });
  }

  private async attemptOnce(
    record: OpenWebhookDeliveryRow,
    app: OpenAppRow,
  ): Promise<OpenWebhookDeliveryRow> {
    const attemptNumber = record.attempts + 1;
    const now = Date.now();
    const timestampSec = Math.floor(now / 1000);
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      "X-DataChat-Event": record.event,
      "X-DataChat-Delivery": record.id,
      "X-DataChat-Timestamp": String(timestampSec),
    };
    const secret = this.resolveSecret(app);
    if (secret) {
      headers["X-DataChat-Signature"] = signWebhookPayload(secret, timestampSec, record.payloadJson);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.timers.add(timer);

    try {
      const response = await this.fetchImpl(record.targetUrl, {
        method: "POST",
        headers,
        body: record.payloadJson,
        signal: controller.signal,
      });
      const text = await response.text().catch(() => "");
      const snippet = text.slice(0, 500) || null;
      const ok = response.status >= 200 && response.status < 300;
      return (
        updateWebhookDelivery(this.db, record.id, {
          status: ok ? "ok" : "failed",
          attempts: attemptNumber,
          httpStatus: response.status,
          responseSnippet: snippet,
          error: ok ? null : `HTTP ${response.status}`,
          lastAttemptAt: Date.now(),
        }) ?? record
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return (
        updateWebhookDelivery(this.db, record.id, {
          status: "failed",
          attempts: attemptNumber,
          httpStatus: null,
          responseSnippet: null,
          error: message.slice(0, 500),
          lastAttemptAt: Date.now(),
        }) ?? record
      );
    } finally {
      clearTimeout(timer);
      this.timers.delete(timer);
    }
  }
}
