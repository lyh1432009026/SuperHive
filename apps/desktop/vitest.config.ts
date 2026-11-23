import { defineConfig } from "vitest/config";

// 单元测试只跑 src 下的 *.test.ts；冒烟测试（test/*.smoke.ts）由 Playwright 跑
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
