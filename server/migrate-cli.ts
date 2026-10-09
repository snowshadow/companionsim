import { closePool } from "./db";
import { migrate, migrationCount } from "./migrations";
import { platformConfigStatus } from "./platform-config";

/** `npm run db:migrate`：显式建表，顺带打印连的是哪个库。 */
const status = await platformConfigStatus();
if (status.state !== "ok") {
  console.error(
    status.state === "invalid"
      ? status.error
      : "缺少 config/platform.json（模板见 config/platform.example.json）",
  );
  process.exit(1);
}
console.log(
  `库：${status.config.mysql.user}@${status.config.mysql.host}:${status.config.mysql.port}/${status.config.mysql.database}`,
);
const applied = await migrate();
console.log(
  applied.length > 0
    ? `已应用迁移：${applied.join(", ")}`
    : `已是最新（共 ${migrationCount()} 条迁移）`,
);
await closePool();
