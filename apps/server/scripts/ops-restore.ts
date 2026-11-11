import path from "node:path";
import { loadConfig } from "../src/config.js";
import { restoreBackup } from "../src/services/ops-backup.js";

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const args = process.argv.slice(2);
const from = argValue(args, "--from");
if (!from) {
  console.error("用法：pnpm ops:restore --from <backup-dir> --yes");
  process.exit(1);
}
if (!args.includes("--yes")) {
  console.error("恢复会覆盖 DATA_DIR，请确认后加 --yes");
  process.exit(1);
}

try {
  const config = loadConfig();
  const result = restoreBackup({ dataDir: config.dataDir, from: path.resolve(from) });
  console.log(`恢复完成。原数据已移动到：${result.rollbackDir}`);
  console.log("请重启服务，并确认 APP_SECRET 与备份时一致。");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
