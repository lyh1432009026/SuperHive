// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LIMITS } from "@superhive/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollapsibleMessage, MAX_MESSAGE_LENGTH, isLongMessage } from "./collapsible-message";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe("CollapsibleMessage", () => {
  it("前端上限与协议契约一致", () => {
    expect(MAX_MESSAGE_LENGTH).toBe(LIMITS.maxMessageLength);
  });

  it("按行数或实际高度判断，不把宽屏里的短段落误判成长消息", () => {
    expect(isLongMessage("短消息")).toBe(false);
    expect(isLongMessage("字".repeat(1501))).toBe(false);
    expect(
      isLongMessage(Array.from({ length: 19 }, (_, index) => `第 ${index} 行`).join("\n")),
    ).toBe(true);
    expect(
      isLongMessage(Array.from({ length: 18 }, (_, index) => `第 ${index} 行`).join("\n")),
    ).toBe(false);
    expect(isLongMessage("short", 600)).toBe(false);
    expect(isLongMessage("short", 601)).toBe(true);
  });

  it("短消息不包裹也不显示按钮", () => {
    render(<CollapsibleMessage content="hi">hi</CollapsibleMessage>);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("短源码在窄屏排版超过 600px 时也会折叠", () => {
    const height = vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(601);
    try {
      const { container } = render(
        <CollapsibleMessage content="短源码">短源码</CollapsibleMessage>,
      );
      expect(container.querySelector(".collapsed")).not.toBeNull();
      expect(screen.getByRole("button", { name: /展开全文/ })).toBeTruthy();
    } finally {
      height.mockRestore();
    }
  });

  it("人的长消息不折叠", () => {
    const { container } = render(
      <CollapsibleMessage content={"长\n".repeat(30)} enabled={false}>
        完整的人类消息
      </CollapsibleMessage>,
    );
    expect(container.querySelector(".message-collapsible")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("记住单条展开与收起状态，定位自动展开且离开高亮后保留", () => {
    const content = "长".repeat(1982) + "\n".repeat(18);
    const props = { content, storageKey: "message-one" };
    const first = render(<CollapsibleMessage {...props}>{content}</CollapsibleMessage>);
    fireEvent.click(screen.getByRole("button", { name: /展开全文/ }));
    first.unmount();
    const second = render(<CollapsibleMessage {...props}>{content}</CollapsibleMessage>);
    expect(second.container.querySelector(".collapsed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    second.unmount();
    const third = render(<CollapsibleMessage {...props}>{content}</CollapsibleMessage>);
    expect(third.container.querySelector(".collapsed")).not.toBeNull();
    third.rerender(
      <CollapsibleMessage {...props} expandOnLocate>
        {content}
      </CollapsibleMessage>,
    );
    third.rerender(<CollapsibleMessage {...props}>{content}</CollapsibleMessage>);
    expect(third.container.querySelector(".collapsed")).toBeNull();
    expect(sessionStorage.getItem("message-one")).toBe("true");
    third.unmount();
    const other = render(
      <CollapsibleMessage content={content} storageKey="message-two">
        {content}
      </CollapsibleMessage>,
    );
    expect(other.container.querySelector(".collapsed")).not.toBeNull();
  });

  it("长消息默认折叠，可展开和收起，正文始终完整渲染", () => {
    const content = "长".repeat(1982) + "\n".repeat(18);
    const { container } = render(
      <CollapsibleMessage content={content}>{content}</CollapsibleMessage>,
    );
    expect(container.querySelector(".message-collapsible.collapsed")).not.toBeNull();
    expect(container.textContent).toContain(content);

    fireEvent.click(screen.getByRole("button", { name: /展开全文 · 共 2,000 字/ }));
    expect(container.querySelector(".message-collapsible.collapsed")).toBeNull();
    expect(screen.getByRole("button", { name: "收起" }).getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(container.querySelector(".message-collapsible.collapsed")).not.toBeNull();
  });

  it("展开、收起前先通知外层，让消息列表暂停贴底", () => {
    const onToggle = vi.fn();
    const content = "长".repeat(1982) + "\n".repeat(18);
    render(
      <CollapsibleMessage content={content} onToggle={onToggle}>
        <p>{content}</p>
      </CollapsibleMessage>,
    );
    fireEvent.click(screen.getByRole("button", { name: /展开全文/ }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("强制展开时不折叠也不显示按钮", () => {
    const content = "长".repeat(1982) + "\n".repeat(18);
    const { container } = render(
      <CollapsibleMessage content={content} forceExpanded>
        {content}
      </CollapsibleMessage>,
    );
    expect(container.querySelector(".collapsed")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
