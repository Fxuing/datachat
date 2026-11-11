import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createBackup } from "../src/services/ops-backup.js";

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const output = argValue(process.argv.slice(2), "--output");
  const result = await createBackup({
    dataDir: config.dataDir,
    ...(output ? { output: path.resolve(output) } : {}),
  });
  console.log(`备份完成：${result.directory}`);
  console.log(
    `  ${result.manifest.files} 个文件，${(result.manifest.bytes / 1024 / 1024).toFixed(1)} MB，数据库 sha256 ${result.manifest.dbSha256.slice(0, 16)}…`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
