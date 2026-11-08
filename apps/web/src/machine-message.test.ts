import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@superhive/protocol";
import { isMachineMessage, machineSummary } from "./machine-message";

const base = {
  id: "00000000-0000-4000-8000-000000000001",
  roomId: "general",
  seq: 3,
  senderId: "00000000-0000-4000-8000-000000000002",
  senderName: "rd-claude3",
  senderType: "agent" as const,
  traceId: "00000000-0000-4000-8000-000000000003",
  hopCount: 1,
  createdAt: new Date().toISOString(),
};
const agents = new Set(["rd-claude", "rd-claude3"]);
const isAgent = (name: string) => agents.has(name);

describe("machine messages", () => {
  it("weakens receipts and delegations between agents, not ones addressed to people", () => {
    const receipt: ChatMessage = {
      ...base,
      kind: "receipt",
      mentions: ["rd-claude"],
      content:
        "@rd-claude 📬 子任务回执（Hive 代 rd-claude3 发出）\n状态：已完成\n委派内容：请 review\n结果（#1678）：\n可以合\n子任务 ID：x",
    };
    expect(isMachineMessage(receipt, isAgent)).toBe(true);
    expect(machineSummary(receipt)).toBe("子任务回执 · 已完成 · 结果见 #1678");
    expect(isMachineMessage({ ...receipt, mentions: ["rd"] }, isAgent)).toBe(false);

    const delegation: ChatMessage = {
      ...base,
      kind: "delegation",
      mentions: ["rd-claude3"],
      content: "@rd-claude3 请 review「撤回并停止」\n做法：……",
    };
    expect(isMachineMessage(delegation, isAgent)).toBe(true);
    expect(machineSummary(delegation)).toBe("委派 · 请 review「撤回并停止」");
    expect(isMachineMessage({ ...delegation, kind: undefined }, isAgent)).toBe(false);
  });
});
