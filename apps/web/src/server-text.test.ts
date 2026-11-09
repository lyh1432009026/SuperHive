import { afterEach, describe, expect, it } from "vitest";
import { serverText, zhText, type ChatMessage, type Invocation } from "@superhive/protocol";
import { setLocalePreference } from "./i18n";
import { machinePreview } from "./machine-message";
import { localizeServerPayload, serverError } from "./server-text";

afterEach(() => setLocalePreference("zh-CN"));

const recalled = serverText("invocation.stoppedReason", {
  reason: serverText("invocation.reasonRecalled"),
});

describe("server texts in the web UI", () => {
  it("shows invocation details, errors and system messages in the current language", () => {
    setLocalePreference("en");
    const invocation = localizeServerPayload({
      status: "cancelled",
      detail: zhText(recalled),
      detailText: recalled,
      progress: "等你批准：写文件",
      progressText: serverText("invocation.approvalWaiting", { summary: "写文件" }),
    } as unknown as Invocation);
    expect(invocation.detail).toBe("Message recalled; stopped");
    // 用户原文作为参数原样保留
    expect(invocation.progress).toBe("Waiting for your approval: 写文件");
    expect(invocation.detailText).toEqual(recalled);

    const event = localizeServerPayload({
      type: "error",
      code: "OWNER_ONLY",
      message: "访客只能忽略自己发起的调用。",
      text: serverText("error.guest.dismissOwn"),
    });
    expect(event.message).toBe("Guests can only dismiss tasks they started.");
    expect(
      serverError({
        error: "房间不存在。",
        code: "ROOM_NOT_FOUND",
        text: { key: "error.room.notFound" },
      }),
    ).toBe("Room not found.");

    const cleared = serverText("topic.cleared", { name: "rd" });
    const message = localizeServerPayload({ content: zhText(cleared), text: cleared });
    expect(message.content).toBe("rd cleared the room");

    // 切回中文：结构化字段还在，同一份数据再走一遍就是中文
    setLocalePreference("zh-CN");
    expect(localizeServerPayload(message).content).toBe("rd 清空了房间");
    expect(localizeServerPayload(invocation).detail).toBe("消息已撤回，已停止");
  });

  it("keeps the original text when the key is unknown or there is no structured text", () => {
    setLocalePreference("en");
    expect(
      localizeServerPayload({ detail: "旧服务端", detailText: { key: "future.key" } }).detail,
    ).toBe("旧服务端");
    expect(localizeServerPayload({ detail: "只有中文" }).detail).toBe("只有中文");
    expect(serverError({ error: "只有中文" })).toBe("只有中文");
    // 执行过程里的 text 是字符串，不是结构化文案
    expect(localizeServerPayload({ steps: [{ kind: "text", text: "中途说的话" }] })).toEqual({
      steps: [{ kind: "text", text: "中途说的话" }],
    });
  });

  it("translates the two options of a permission request", () => {
    setLocalePreference("en");
    const message = localizeServerPayload({
      approval: { requestId: "r", tool: "Bash" },
      question: {
        options: [
          { key: "A", label: "允许" },
          { key: "B", label: "拒绝" },
        ],
        multiple: false,
      },
    });
    expect(message.question.options.map((option) => option.label)).toEqual(["Allow", "Deny"]);
  });

  it("reads receipt status and result from the structured text", () => {
    setLocalePreference("en");
    const text = serverText("receipt.delegation", {
      requester: "rd-claude",
      delegate: "rd-claude3",
      status: serverText("receipt.status.completed"),
      task: "请 review",
      outcome: serverText("receipt.result", { seq: 1678, result: "可以合" }),
      id: "x",
    });
    const receipt = {
      kind: "receipt",
      mentions: ["rd-claude"],
      content: zhText(text),
      text,
    } as unknown as ChatMessage;
    const preview = machinePreview(localizeServerPayload(receipt));
    // 标签里的「子任务回执」「结果见」来自 en.json（另有人在润色），这里只核对服务端那部分
    expect(preview.label).toMatch(/→ @rd-claude · Completed · .*1678/);
    expect(preview.text).toBe("可以合");
  });
});
