import type { DatasourceType } from "@datachat/shared";
import { safeDriverErrorMessage, type OptionValue } from "@datachat/datasource-sdk";
import { defaultDriverRegistry, type DriverRegistry } from "../../drivers/registry.js";
import type { SslMode } from "./pool.js";

export interface ProbeInput {
  type: DatasourceType;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslMode: SslMode;
  options?: Record<string, OptionValue | undefined>;
}

export interface ProbeResult {
  ok: boolean;
  serverVersion?: string;
  readOnly: boolean;
  warnings: string[];
  error?: string;
}

/** Collapse driver errors so responses stay single-line and never echo secrets. */
export function safeErrorMessage(error: unknown, secret?: string | Array<string | undefined>): string {
  const secrets = Array.isArray(secret) ? secret : secret ? [secret] : [];
  return safeDriverErrorMessage(error, secrets);
}

export async function probeDatasource(
  input: ProbeInput,
  drivers: DriverRegistry = defaultDriverRegistry,
): Promise<ProbeResult> {
  const driver = drivers.get(input.type);
  if (!driver) {
    return {
      ok: false,
      readOnly: false,
      warnings: [],
      error: `未安装「${input.type}」数据源驱动插件`,
    };
  }
  try {
    return await driver.probe({
      id: "probe",
      type: input.type,
      host: input.host,
      port: input.port,
      database: input.database,
      username: input.username,
      password: input.password,
      sslMode: input.sslMode,
      options: input.options ?? {},
    });
  } catch (error) {
    return {
      ok: false,
      readOnly: false,
      warnings: [],
      error: safeErrorMessage(error, input.password),
    };
  }
}
