import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import aiIns from "@ai-ins/astro";

function setup(command) {
  const updates = [];
  const scripts = [];
  aiIns().hooks["astro:config:setup"]({
    command,
    updateConfig: (config) => updates.push(config),
    injectScript: (stage, code) => scripts.push({ stage, code }),
  });
  return { updates, scripts };
}

test("AI Ins is enabled through the native Astro integration in development only", () => {
  const config = readFileSync(new URL("../astro.config.mjs", import.meta.url), "utf8");
  assert.ok(config.includes('import aiIns from "@ai-ins/astro"'));
  const { updates, scripts } = setup("dev");
  assert.equal(updates.length, 1);
  assert.deepEqual(
    updates[0].vite.plugins.map((plugin) => plugin.name),
    ["ai-ins:astro-source", "ai-ins:vite"],
  );
  assert.ok(updates[0].vite.plugins.every((plugin) => plugin.apply === "serve"));
  assert.deepEqual(scripts, [{ stage: "page", code: "import 'ai-ins/client';" }]);
});

test("build, production preview and checks install no AI Ins scripts or endpoints", () => {
  for (const command of ["build", "preview", "check", "sync"]) {
    assert.deepEqual(setup(command), { updates: [], scripts: [] });
  }
});

test("development source mapping locates Astro markup inside the documentation workspace", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const source = setup("dev").updates[0].vite.plugins[0];
  source.configResolved({ root });
  const filename = `${root}src/components/Test.astro`;
  const result = await source.transform.handler("<h1>协作文档</h1>", filename, { ssr: true });
  assert.ok(result.code.includes('data-ai-ins-source="src/components/Test.astro:1:1-1:14"'));
  assert.equal(
    await source.transform.handler("<h1>Text</h1>", `${root}node_modules/Test.astro`, {
      ssr: true,
    }),
    null,
  );
});
