import { describe, expect, it } from "vitest";
import type { LocalAgentModelsResponse } from "@superhive/protocol";
import { memberModel, modelDisplayName } from "./agent-models";

const omp: LocalAgentModelsResponse = {
  source: "runtime",
  efforts: [],
  models: [
    { id: "zhipu/glm-5.3", label: "GLM 5.3", isDefault: true },
    { id: "zhipu/glm-5.3-flash" },
  ],
};
const claude: LocalAgentModelsResponse = {
  source: "preset",
  efforts: [],
  models: [
    { id: "claude-opus-5-5[1m]", isDefault: true },
    { id: "opus", label: "Opus" },
  ],
};
const lists = new Map([
  ["omp", omp],
  ["claude", claude],
]);

describe("agent models", () => {
  it("names a model from the runtime list, then Claude ids, else the id", () => {
    expect(modelDisplayName("zhipu/glm-5.3", omp)).toBe("GLM 5.3");
    expect(modelDisplayName("zhipu/glm-5.3-flash", omp)).toBe("zhipu/glm-5.3-flash");
    expect(modelDisplayName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelDisplayName("claude-opus-5-5[1m]")).toBe("Opus 5.5 (1M)");
    expect(modelDisplayName("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
    expect(modelDisplayName("gpt-6.1-sol")).toBe("gpt-6.1-sol");
  });

  it("prefers the last turn's model, then the setting, then the runtime default", () => {
    const agent = { username: "Helper", provider: "omp" as const };
    const at = "2026-11-26T00:00:00.000Z";
    const local = [{ name: "helper", provider: "omp" as const, model: null }];
    expect(memberModel({ ...agent, lastModel: { id: "zhipu/glm-5.3", at } }, local, lists)).toEqual(
      { id: "zhipu/glm-5.3", name: "GLM 5.3" },
    );
    expect(memberModel(agent, [{ ...local[0]!, model: "zhipu/glm-5.3-flash" }], lists)?.id).toBe(
      "zhipu/glm-5.3-flash",
    );
    expect(memberModel(agent, local, lists)).toEqual({ id: "zhipu/glm-5.3", name: "GLM 5.3" });
    expect(
      memberModel(
        { username: "c", provider: "claude" },
        [{ name: "c", provider: "claude", model: null }],
        lists,
      ),
    ).toEqual({ id: "claude-opus-5-5[1m]", name: "Opus 5.5 (1M)" });
    // 不是本机 Agent、也没回复过：不知道
    expect(memberModel(agent, [], lists)).toBeUndefined();
  });
});
