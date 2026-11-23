import { defineConfig } from "@playwright/test";

/** 冒烟测试：真的启动 Electron（.stage/app），用独立的数据目录和端口，不碰 ~/.superhive */
export default defineConfig({
  testDir: "test",
  testMatch: "**/*.smoke.ts",
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results",
});
