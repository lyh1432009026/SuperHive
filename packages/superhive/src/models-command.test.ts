import { describe, expect, it, vi } from "vitest";
import { listModels } from "./models-command.js";

describe("listModels", () => {
  it("reads Codex models from app-server model/list, skipping hidden ones", async () => {
    const listCodex = vi.fn(async () => ({
      data: [
        { id: "gpt-a", model: "gpt-a", displayName: "GPT A", isDefault: true, hidden: false },
        { id: "gpt-b", model: "gpt-b", displayName: "gpt-b", hidden: false },
        { id: "gpt-secret", model: "gpt-secret", hidden: true },
      ],
    }));
    await expect(listModels({ provider: "codex", listCodex })).resolves.toEqual({
      provider: "codex",
      source: "runtime",
      models: [{ id: "gpt-a", label: "GPT A", isDefault: true }, { id: "gpt-b" }],
    });
    expect(listCodex).toHaveBeenCalledWith("codex");
  });

  it("parses opencode, omp and openclaw output", async () => {
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "models" && args.length === 1)
        return "opencode/big-pickle\nzhipu-coding/glm-5.3\nsome log line\n";
      if (args.join(" ") === "models --json")
        return JSON.stringify({
          models: [
            { kind: "chat", selector: "zhipu/glm-5", name: "GLM-5" },
            { kind: "embedding", selector: "zhipu/embed", name: "Embed" },
          ],
        });
      return `🦞 banner\n${JSON.stringify({
        models: [
          { key: "codex/gpt-5.5", name: "gpt-5.5", available: true, tags: ["default"] },
          { key: "x/gone", name: "gone", available: false, tags: [] },
        ],
      })}`;
    });
    expect((await listModels({ provider: "opencode", run })).models).toEqual([
      { id: "opencode/big-pickle" },
      { id: "zhipu-coding/glm-5.3" },
    ]);
    expect((await listModels({ provider: "omp", run })).models).toEqual([
      { id: "zhipu/glm-5", label: "GLM-5" },
    ]);
    expect((await listModels({ provider: "openclaw", run })).models).toEqual([
      { id: "codex/gpt-5.5", label: "gpt-5.5", isDefault: true },
    ]);
  });

  it("reads gemini and agy models from an ACP session", async () => {
    const listAcp = vi.fn(async (provider: "gemini" | "agy") =>
      provider === "gemini"
        ? {
            sessionId: "s",
            models: {
              currentModelId: "gemini-2.5-pro",
              availableModels: [
                { modelId: "auto", name: "Auto" },
                { modelId: "gemini-2.5-pro", name: "gemini-2.5-pro" },
              ],
            },
          }
        : {
            sessionId: "s",
            configOptions: [
              {
                id: "model",
                currentValue: "gemini-3.1-pro",
                options: [
                  { value: "gemini-4-neon", name: "Gemini 4 Neon" },
                  { value: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
                ],
              },
            ],
            models: { availableModels: [{ modelId: "ignored-when-config-options-exist" }] },
          },
    );
    await expect(listModels({ provider: "gemini", listAcp })).resolves.toEqual({
      provider: "gemini",
      source: "runtime",
      models: [
        { id: "auto", label: "Auto" },
        { id: "gemini-2.5-pro", isDefault: true },
      ],
    });
    expect((await listModels({ provider: "agy", listAcp, command: "/bin/agy" })).models).toEqual([
      { id: "gemini-4-neon", label: "Gemini 4 Neon" },
      { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro", isDefault: true },
    ]);
    expect(listAcp).toHaveBeenLastCalledWith("agy", "/bin/agy");

    const failed = await listModels({
      provider: "agy",
      listAcp: async () => {
        throw new Error("Authentication required");
      },
    });
    expect(failed).toMatchObject({
      source: "preset",
      models: [],
      error: "Authentication required",
    });
  });

  it("gives common options for runtimes without a model list command", async () => {
    const run = vi.fn();
    const claude = await listModels({ provider: "claude", run });
    expect(claude.source).toBe("preset");
    expect(claude.models.map((model) => model.id)).toEqual(["opus", "sonnet", "haiku", "opusplan"]);
    expect((await listModels({ provider: "copilot", run })).models[0]!.id).toBe("auto");
    expect(run).not.toHaveBeenCalled();
  });

  it("reports why the list could not be fetched instead of failing", async () => {
    const result = await listModels({
      provider: "opencode",
      run: async () => {
        throw new Error("spawn opencode ENOENT");
      },
    });
    expect(result).toEqual({
      provider: "opencode",
      source: "preset",
      models: [],
      error: "spawn opencode ENOENT",
    });
  });
});
