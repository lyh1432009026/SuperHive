import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatMessage, ServerEvent } from "@superhive/protocol";
import { buildApp } from "./app.js";
import { Peer } from "./test-peer.js";

const OWNER = { Authorization: "Bearer test-token" };

describe("附件用本机应用打开 / 在访达中显示", () => {
  let close: (() => Promise<void>) | undefined;
  const peers: Peer[] = [];
  afterEach(async () => {
    for (const peer of peers.splice(0)) peer.socket.close();
    await close?.();
    close = undefined;
  });

  async function start() {
    const filesDir = mkdtempSync(path.join(tmpdir(), "hive-files-test-"));
    const opened: string[] = [];
    const revealed: string[] = [];
    const app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      staticDir: "/definitely-not-present",
      attachmentsDir: mkdtempSync(path.join(tmpdir(), "hive-att-open-")),
      attachmentFilesDir: filesDir,
      openWithDefaultApp: vi.fn(async (file: string) => {
        opened.push(file);
      }),
      revealInFolder: vi.fn(async (file: string) => {
        revealed.push(file);
      }),
      localAgents: {
        cli: { command: "/usr/bin/node", args: ["cli.js"] },
        serverUrl: "http://127.0.0.1:8787",
        spawn: () => {
          throw new Error("no agents");
        },
        probe: async () => ({ installed: true, version: "1.0.0" }),
      },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    close = () => app.close();
    const port = (app.server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const { ownerToken } = (await (await fetch(`${base}/api/local/session`)).json()) as {
      ownerToken: string;
    };
    const upload = async (name: string, content: string) => {
      const form = new FormData();
      form.append("file", new Blob([content]), name);
      const response = await fetch(`${base}/api/rooms/general/attachments`, {
        method: "POST",
        headers: OWNER,
        body: form,
      });
      return (await response.json()) as { id: string; sha256: string };
    };
    const owner = await Peer.connect(`ws://127.0.0.1:${port}/ws`);
    peers.push(owner);
    owner.send({
      type: "participant.join",
      username: "rd",
      participantType: "human",
      token: "test-token",
    });
    await owner.next((event) => event.type === "room.snapshot");
    let sent = 0;
    const send = async (...ids: string[]): Promise<ChatMessage> => {
      owner.send({ type: "message.send", clientMessageId: `m${++sent}`, attachmentIds: ids });
      const event: ServerEvent = await owner.next(
        (item) => item.type === "message.created" || item.type === "error",
      );
      if (event.type !== "message.created") throw new Error(JSON.stringify(event));
      return event.message;
    };
    const open = async (
      id: string,
      mode: string,
      options: { roomId?: string; headers?: Record<string, string> } = {},
    ) => {
      const response = await fetch(
        `${base}/api/local/rooms/${options.roomId ?? "general"}/attachments/${id}/open`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(options.headers ?? { "x-hive-owner": ownerToken }),
          },
          body: JSON.stringify({ mode }),
        },
      );
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };
    return { owner, upload, send, open, opened, revealed, filesDir };
  }

  it("按原文件名放副本后打开或选中；同名同内容复用，同名不同内容加后缀", async () => {
    const { upload, send, open, opened, revealed, filesDir } = await start();
    const a = await upload("周报.docx", "first");
    const same = await upload("周报.docx", "first");
    const other = await upload("周报.docx", "second");
    await send(a.id, same.id, other.id);

    expect(await open(a.id, "open")).toEqual({
      status: 200,
      body: { opened: true, name: "周报.docx" },
    });
    const dir = path.join(filesDir, "general");
    expect(opened).toEqual([path.join(dir, "周报.docx")]);
    expect(readFileSync(opened[0]!, "utf8")).toBe("first");

    expect((await open(same.id, "reveal")).body.name).toBe("周报.docx");
    expect(revealed).toEqual([path.join(dir, "周报.docx")]);

    expect((await open(other.id, "open")).body.name).toBe("周报 (2).docx");
    expect(readFileSync(path.join(dir, "周报 (2).docx"), "utf8")).toBe("second");
    // 再点一次还是同一份，不会越放越多
    expect((await open(other.id, "reveal")).body.name).toBe("周报 (2).docx");

    // 用户改过副本：不覆盖他的改动，另放一份
    writeFileSync(path.join(dir, "周报.docx"), "edited by user");
    expect((await open(a.id, "open")).body.name).toBe("周报 (3).docx");
    expect(readFileSync(path.join(dir, "周报.docx"), "utf8")).toBe("edited by user");
    expect(readdirSync(dir).sort()).toEqual(["周报 (2).docx", "周报 (3).docx", "周报.docx"]);
  });

  it("只认这个房间里发出、没撤回的附件；会运行代码的类型只能选中", async () => {
    const { owner, upload, send, open, opened, revealed } = await start();
    const doc = await upload("a.md", "hello");
    const message = await send(doc.id);
    const pending = await upload("b.md", "not sent");
    const script = await upload("run.command", "echo hi");
    await send(script.id);

    expect((await open(doc.id, "open", { roomId: "other" })).status).toBe(404);
    expect((await open(pending.id, "open")).status).toBe(404);
    expect((await open("missing", "reveal")).status).toBe(404);
    expect((await open(doc.id, "launch")).status).toBe(400);

    const blocked = await open(script.id, "open");
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe("ATTACHMENT_OPEN_BLOCKED");
    expect((await open(script.id, "reveal")).status).toBe(200);
    expect(opened).toEqual([]);
    expect(revealed).toHaveLength(1);

    owner.send({ type: "message.delete", messageId: message.id });
    await owner.next((event) => event.type === "message.deleted");
    const recalled = await open(doc.id, "open");
    expect(recalled.status).toBe(410);
    expect(recalled.body.code).toBe("ATTACHMENT_REVOKED");
    expect(opened).toEqual([]);
  });

  it("只限本机房主：总令牌和没带本机凭证的请求都不行", async () => {
    const { upload, send, open, opened, revealed } = await start();
    const doc = await upload("a.md", "hello");
    await send(doc.id);
    expect((await open(doc.id, "open", { headers: OWNER })).status).toBe(401);
    expect((await open(doc.id, "reveal", { headers: {} })).status).toBe(401);
    expect(opened).toEqual([]);
    expect(revealed).toEqual([]);
  });
});
