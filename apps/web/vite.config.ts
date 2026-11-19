import aiIns from "@ai-ins/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { hiveDevStatus } from "./dev-status-plugin";
import { pptxPreviewPatches } from "./pptx-preview-plugin";

export default defineConfig({
  plugins: [aiIns(), react(), hiveDevStatus(), pptxPreviewPatches()],
  // 开发时依赖预构建不走上面的 plugins，pptx-preview 的补丁要在这里再挂一次
  optimizeDeps: { rolldownOptions: { plugins: [pptxPreviewPatches()] } },
  server: { port: 5188 },
});
