import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../apps/server/src/app.js";
import { HiveDatabase } from "../apps/server/src/database.js";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "hive-composer-ui-")));
const databasePath = path.join(root, "db.sqlite");
const token = randomBytes(24).toString("hex");
const seed = new HiveDatabase(databasePath);
seed.updateRoom("general", { name: "Composer smoke" });
seed.close();
const app = await buildApp({
  databasePath,
  token,
  staticDir: path.resolve(import.meta.dirname, "../apps/web/dist"),
});
await app.listen({ host: "127.0.0.1", port: 0 });
console.log(`URL=http://127.0.0.1:${(app.server.address() as AddressInfo).port}`);
console.log(`TOKEN=${token}`);
process.on("SIGTERM", () => {
  void app.close().finally(() => {
    rmSync(root, { recursive: true, force: true });
    process.exit(0);
  });
});
process.on("SIGINT", () => process.emit("SIGTERM"));
