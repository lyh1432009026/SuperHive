import { afterEach, describe, expect, it } from "vitest";
import { serverText, zhText, type ChatMessage, type Invocation } from "@superhive/protocol";
import { setLocalePreference } from "./i18n";
import { machinePreview } from "./machine-message";
import { localizeServerPayload, messageBodyContent, serverError } from "./server-text";

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
    expect(invocation.detail).toBe("Message unsent; stopped");
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

describe("question bubble body", () => {
  const ask = (choices: boolean) =>
    serverText("question.ask", {
      asker: "@rd ",
      question: "用哪个方案？",
      choices: choices
        ? serverText("question.choices", {
            mode: serverText("question.multiple"),
            options: "A. 甲\nB. 乙",
          })
        : "",
      hint: serverText(choices ? "question.hintOptions" : "question.hintReply", {
        agent: "rd-claude",
      }),
    });
  const message = (text: ReturnType<typeof ask>, withSpec: boolean) =>
    localizeServerPayload({
      content: zhText(text),
      text,
      kind: "question",
      ...(withSpec
        ? {
            question: {
              multiple: true,
              options: [
                { key: "A", label: "甲" },
                { key: "B", label: "乙" },
              ],
            },
          }
        : {}),
    } as unknown as ChatMessage);

  it("shows only the question when options render as a card, keeping the full content", () => {
    for (const locale of ["zh-CN", "en"] as const) {
      setLocalePreference(locale);
      const localized = message(ask(true), true);
      expect(messageBodyContent(localized)).toBe("@rd ❓ 用哪个方案？");
      // 复制、导出仍用完整原文
      expect(localized.content).toContain("A. 甲");
      expect(localized.content).toContain(locale === "en" ? "(Pick one or more)" : "（可多选）");
    }
  });

  it("keeps the reply hint for free-form questions and falls back to content without text", () => {
    const free = message(ask(false), false);
    expect(messageBodyContent(free)).toBe(free.content);
    expect(free.content).toContain("回复这条消息");
    const legacy = { ...message(ask(true), true), text: undefined } as ChatMessage;
    expect(messageBodyContent(legacy)).toBe(legacy.content);
  });

  it("drops Allow / Deny lines from approval requests", () => {
    setLocalePreference("en");
    const text = serverText("approval.request", {
      asker: "",
      agent: "rd-codex",
      tool: "Bash",
      summary: "pnpm test",
      detail: "",
      minutes: 10,
    });
    const approval = localizeServerPayload({
      content: zhText(text),
      text,
      kind: "question",
      question: {
        multiple: false,
        options: [
          { key: "A", label: "允许" },
          { key: "B", label: "拒绝" },
        ],
      },
      approval: { requestId: "00000000-0000-4000-8000-000000000000", tool: "Bash" },
    } as unknown as ChatMessage);
    expect(messageBodyContent(approval)).toBe(
      "🔐 rd-codex is requesting permission (Bash): pnpm test\n(It's denied if no one decides within 10 min.)",
    );
    expect(approval.content).toContain("A. Allow");
  });
});
