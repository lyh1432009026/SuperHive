import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ChatMessage, ServerEvent, UploadedAttachment } from "@superhive/protocol";
import { buildApp, type BuildAppOptions } from "./app.js";
import { Peer } from "./test-peer.js";

const OWNER = { Authorization: "Bearer test-token" };
const errorCode = (event: ServerEvent) => (event.type === "error" ? event.code : undefined);

/** 1×1 透明 PNG */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

describe("附件", () => {
  let close: (() => Promise<void>) | undefined;
  const peers: Peer[] = [];
  afterEach(async () => {
    for (const peer of peers.splice(0)) peer.socket.close();
    await close?.();
    close = undefined;
  });

  async function start(options: Partial<BuildAppOptions> = {}) {
    let now = Date.now();
    const dir = mkdtempSync(path.join(tmpdir(), "hive-att-test-"));
    const app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      staticDir: "/definitely-not-present",
      attachmentsDir: dir,
      now: () => now,
      ...options,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    close = () => app.close();
    const port = (app.server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const upload = async (
      name: string,
      content: Buffer | string,
      headers: Record<string, string> = OWNER,
      roomId = "general",
    ) => {
      const form = new FormData();
      form.append(
        "file",
        new Blob([typeof content === "string" ? content : new Uint8Array(content)]),
        name,
      );
      const response = await fetch(`${base}/api/rooms/${roomId}/attachments`, {
        method: "POST",
        headers,
        body: form,
      });
      const text = await response.text();
      return {
        status: response.status,
        body: (text ? JSON.parse(text) : {}) as Record<string, any>,
        text,
      };
    };
    const download = (id: string, headers: Record<string, string> = OWNER) =>
      fetch(`${base}/api/attachments/${id}`, { headers });
    const join = async (username: string, type: "human" | "agent", token = "test-token") => {
      const peer = await Peer.connect(`ws://127.0.0.1:${port}/ws`);
      peers.push(peer);
      peer.send({ type: "participant.join", username, participantType: type, token });
      await peer.next((event) => event.type === "room.snapshot");
      return peer;
    };
    const sendMessage = async (peer: Peer, input: Record<string, unknown>) => {
      peer.send({ type: "message.send", ...input });
      return peer.next((event) => event.type === "message.created" || event.type === "error");
    };
    const guest = async (username: string, roomId = "general") => {
      const json = { ...OWNER, "Content-Type": "application/json" };
      if (roomId !== "general") {
        await fetch(`${base}/api/rooms`, {
          method: "POST",
          headers: json,
          body: JSON.stringify({ id: roomId }),
        });
      }
      const invite = (await (
        await fetch(`${base}/api/rooms/${roomId}/invites`, {
          method: "POST",
          headers: json,
          body: JSON.stringify({ expiresInMinutes: 60, allowAgents: false }),
        })
      ).json()) as { token: string };
      const redeemed = (await (
        await fetch(`${base}/api/invites/redeem`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: invite.token, username }),
        })
      ).json()) as { token: string };
      return { token: redeemed.token, headers: { Authorization: `Bearer ${redeemed.token}` } };
    };
    return {
      app,
      dir,
      base,
      port,
      upload,
      download,
      join,
      sendMessage,
      guest,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  const created = (event: ServerEvent): ChatMessage => {
    if (event.type !== "message.created")
      throw new Error(`expected message.created: ${JSON.stringify(event)}`);
    return event.message;
  };

  it("上传图片后只有上传者能读；随消息发出后同房间可读、其他房间拒绝", async () => {
    const { upload, download, join, sendMessage, guest } = await start();
    const owner = await join("rd", "human");
    const alice = await guest("alice");
    const outsider = await guest("eve", "secret");

    const uploaded = await upload("../../shot.png", PNG);
    expect(uploaded.status).toBe(201);
    const item = uploaded.body as UploadedAttachment;
    expect(item).toMatchObject({
      name: "shot.png",
      kind: "image",
      mime: "image/png",
      size: PNG.length,
      width: 1,
      height: 1,
      roomId: "general",
    });
    // 还没发出：访客（另一个上传者）看不到
    expect((await download(item.id, alice.headers)).status).toBe(404);
    expect((await download(item.id)).status).toBe(200);

    // 只带附件、正文为空
    const message = created(
      await sendMessage(owner, { clientMessageId: "m1", attachmentIds: [item.id] }),
    );
    expect(message.content).toBe("");
    expect(message.attachments).toEqual([
      expect.objectContaining({ id: item.id, name: "shot.png", kind: "image" }),
    ]);

    const read = await download(item.id, alice.headers);
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("image/png");
    expect(read.headers.get("x-content-type-options")).toBe("nosniff");
    expect(read.headers.get("content-disposition")).toMatch(/^inline/);
    expect(Buffer.from(await read.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await download(item.id, outsider.headers)).status).toBe(403);
    expect((await download(item.id, {})).status).toBe(401);
    // 凭证只认 Authorization 头，不认 URL 参数
    expect((await fetch(`${read.url}?token=test-token`)).status).toBe(401);
  });

  it("HTML、SVG 按纯文本下载，不交给浏览器渲染；二进制文件不内联", async () => {
    const { upload, download } = await start();
    const html = (await upload("page.html", "<script>alert(1)</script>")).body;
    expect(html).toMatchObject({ kind: "text", mime: "text/plain" });
    const svg = (await upload("logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>')).body;
    expect(svg.kind).toBe("text");
    const response = await download(html.id);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    const binary = (await upload("blob.dat", Buffer.from([0, 1, 2, 3, 0xff]))).body;
    expect(binary).toMatchObject({ kind: "file", mime: "application/octet-stream" });
  });

  it("认出常见音视频的文件头：mp4 / mov / webm / mp3 / wav 记成对应 MIME，下载照旧 attachment + sandbox", async () => {
    const { upload, download } = await start();
    const box = (brand: string) =>
      Buffer.concat([
        Buffer.from([0, 0, 0, 0x18]),
        Buffer.from(`ftyp${brand}`, "latin1"),
        Buffer.alloc(16),
      ]);
    const cases: Array<[string, Buffer, string]> = [
      ["clip.mp4", box("isom"), "video/mp4"],
      ["clip.mov", box("qt  "), "video/quicktime"],
      ["voice.m4a", box("M4A "), "audio/mp4"],
      ["clip.webm", Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]), "video/webm"],
      [
        "song.mp3",
        Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([4, 0, 0, 0])]),
        "audio/mpeg",
      ],
      [
        "tone.wav",
        Buffer.concat([
          Buffer.from("RIFF", "latin1"),
          Buffer.alloc(4),
          Buffer.from("WAVEfmt ", "latin1"),
        ]),
        "audio/wav",
      ],
    ];
    for (const [name, bytes, mime] of cases) {
      const item = (await upload(name, bytes)).body;
      expect(item, name).toMatchObject({ kind: "file", mime });
    }
    const video = (await upload("clip.mp4", box("mp42"))).body;
    const response = await download(video.id);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("文件头是 %PDF- 的记成 application/pdf（开头像文本也一样），下载照旧 attachment + sandbox", async () => {
    const { upload, download } = await start();
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n", "latin1");
    const item = (await upload("报告", pdf)).body;
    expect(item).toMatchObject({ kind: "file", mime: "application/pdf" });
    const response = await download(item.id);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    // 只是扩展名叫 .pdf 的文本照旧是文本
    expect((await upload("fake.pdf", "hello")).body).toMatchObject({ kind: "text" });
  });

  it("HTML 附件可换短时预览链接：只给 html、按读权限、过期失效，响应是不透明源的 sandbox 页面", async () => {
    const { upload, join, sendMessage, guest, base, advance } = await start();
    const owner = await join("rd", "human");
    const alice = await guest("alice");
    const outsider = await guest("eve", "secret");
    const preview = (id: string, headers: Record<string, string> = OWNER) =>
      fetch(`${base}/api/attachments/${id}/preview`, { method: "POST", headers });
    const page = "<!doctype html><script>document.title = 'ok'</script><h1>Hi</h1>";
    const html = (await upload("report.html", page)).body;
    const text = (await upload("notes.txt", "hello")).body;
    created(
      await sendMessage(owner, {
        clientMessageId: "html",
        content: "看看",
        attachmentIds: [html.id, text.id],
      }),
    );

    // 只有 html 能预览；没有读权限的拿不到；不带凭证不行
    expect((await preview(text.id)).status).toBe(415);
    expect((await preview(html.id, outsider.headers)).status).toBe(403);
    expect((await preview(html.id, {})).status).toBe(401);

    // 同房间的访客和下载权限一致，也能预览
    const granted = await preview(html.id, alice.headers);
    expect(granted.status).toBe(200);
    const { url } = (await granted.json()) as { url: string };
    expect(url).toMatch(/^\/api\/attachment-previews\/[\w-]{20,}$/);

    // 预览地址本身不需要凭证，返回原文和 sandbox CSP（没有 allow-same-origin，onSend 没覆盖它）
    const served = await fetch(`${base}${url}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(served.headers.get("content-disposition")).toBe("inline");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("cache-control")).toBe("no-store");
    expect(served.headers.get("referrer-policy")).toBe("no-referrer");
    const policy = served.headers.get("content-security-policy") ?? "";
    expect(policy).toMatch(/^sandbox allow-scripts allow-popups allow-forms allow-modals;/);
    expect(policy).not.toContain("allow-same-origin");
    expect(policy).toContain("frame-ancestors 'self'");
    expect(policy).not.toContain("script-src 'self'");
    expect(await served.text()).toBe(page);

    // 网页和 Server 不同源（开发时的 Vite、单独部署的前端）：申请时的 Origin 进 frame-ancestors，弹窗里才嵌得进去；
    // 乱写的 Origin 不会被塞进 CSP
    const crossOrigin = await preview(html.id, { ...OWNER, Origin: "http://localhost:5188" });
    const crossUrl = ((await crossOrigin.json()) as { url: string }).url;
    expect((await fetch(`${base}${crossUrl}`)).headers.get("content-security-policy")).toContain(
      "frame-ancestors 'self' http://localhost:5188;",
    );
    const bogus = await preview(html.id, { ...OWNER, Origin: "javascript:alert(1); script-src *" });
    const bogusUrl = ((await bogus.json()) as { url: string }).url;
    const bogusPolicy = (await fetch(`${base}${bogusUrl}`)).headers.get("content-security-policy");
    expect(bogusPolicy).toContain("frame-ancestors 'self';");
    expect(bogusPolicy).not.toContain("javascript");

    // 猜不到的 token、过期后的 token 都是 404
    expect((await fetch(`${base}/api/attachment-previews/nope`)).status).toBe(404);
    advance(5 * 60_000 + 1);
    expect((await fetch(`${base}${url}`)).status).toBe(404);
  });

  it("重发同一条消息幂等；附件不能被第二条消息再用；空消息被拒", async () => {
    const { upload, join, sendMessage } = await start();
    const owner = await join("rd", "human");
    const item = (await upload("a.txt", "hello")).body;
    const first = created(
      await sendMessage(owner, {
        clientMessageId: "same",
        content: "看看",
        attachmentIds: [item.id],
      }),
    );
    const again = created(
      await sendMessage(owner, {
        clientMessageId: "same",
        content: "看看",
        attachmentIds: [item.id],
      }),
    );
    expect(again.id).toBe(first.id);
    expect(
      errorCode(await sendMessage(owner, { clientMessageId: "other", attachmentIds: [item.id] })),
    ).toBe("ATTACHMENT_UNAVAILABLE");
    expect(errorCode(await sendMessage(owner, { clientMessageId: "empty", content: "  " }))).toBe(
      "EMPTY_MESSAGE",
    );
  });

  it("访客不能把别人待发的附件挂到自己消息上，也不能跨房间", async () => {
    const { upload, join, sendMessage, guest } = await start();
    await join("rd", "human");
    const ownerItem = (await upload("a.txt", "secret")).body;
    const alice = await guest("alice");
    const alicePeer = await join("alice", "human", alice.token);
    expect(
      errorCode(
        await sendMessage(alicePeer, { clientMessageId: "x", attachmentIds: [ownerItem.id] }),
      ),
    ).toBe("ATTACHMENT_UNAVAILABLE");
    const own = (await upload("b.txt", "mine", alice.headers)).body;
    expect(
      created(await sendMessage(alicePeer, { clientMessageId: "y", attachmentIds: [own.id] }))
        .attachments,
    ).toHaveLength(1);
    // 访客上传到别的房间
    expect((await upload("c.txt", "x", alice.headers, "secret")).status).toBe(403);
  });

  it("未发出的附件 24 小时后过期，清理后文件删除", async () => {
    const { app, upload, download, join, sendMessage, advance, dir } = await start();
    const owner = await join("rd", "human");
    const item = (await upload("old.txt", "stale")).body;
    advance(24 * 60 * 60_000 + 1);
    expect((await download(item.id)).status).toBe(410);
    expect(
      errorCode(await sendMessage(owner, { clientMessageId: "late", attachmentIds: [item.id] })),
    ).toBe("ATTACHMENT_EXPIRED");
    const files = () => readdirSync(dir).filter((name) => name !== ".tmp");
    expect(files()).toHaveLength(1);
    (app as unknown as { attachmentStore: { sweep(): unknown } }).attachmentStore.sweep();
    expect(readdirSync(path.join(dir, files()[0]!))).toEqual([]);
  });

  it("撤回只撤这条消息的引用；内容相同的另一条仍可读，最后一个引用撤回后文件被清理", async () => {
    const { upload, download, join, sendMessage, advance, dir, app } = await start();
    const owner = await join("rd", "human");
    const a = (await upload("same.txt", "shared content")).body;
    const b = (await upload("same-copy.txt", "shared content")).body;
    expect(a.sha256).toBe(b.sha256);
    const m1 = created(await sendMessage(owner, { clientMessageId: "1", attachmentIds: [a.id] }));
    const m2 = created(await sendMessage(owner, { clientMessageId: "2", attachmentIds: [b.id] }));

    owner.send({ type: "message.delete", messageId: m1.id });
    const deleted = await owner.next((event) => event.type === "message.deleted");
    expect(deleted.type === "message.deleted" && deleted.message.attachments).toBeFalsy();
    expect((await download(a.id)).status).toBe(410);
    expect((await download(b.id)).status).toBe(200);

    const sweep = () =>
      (app as unknown as { attachmentStore: { sweep(): unknown } }).attachmentStore.sweep();
    advance(11 * 60_000);
    sweep();
    const blob = path.join(dir, a.sha256.slice(0, 2));
    expect(readdirSync(blob)).toHaveLength(1);

    owner.send({ type: "message.delete", messageId: m2.id });
    await owner.next((event) => event.type === "message.deleted");
    advance(11 * 60_000);
    sweep();
    expect(existsSync(blob) ? readdirSync(blob) : []).toHaveLength(0);
  });

  it("超出房间配额与单文件上限时拒绝", async () => {
    const { upload } = await start({ roomAttachmentQuotaBytes: 1024 });
    expect((await upload("a.txt", "x".repeat(800))).status).toBe(201);
    const over = await upload("b.txt", "y".repeat(800));
    expect(over.status).toBe(413);
    expect(over.body.code).toBe("ROOM_ATTACHMENT_QUOTA");
  });

  it("单个文件超过 20 MiB 被拒绝，临时文件不残留", async () => {
    const { upload, dir } = await start();
    const big = await upload("big.bin", Buffer.alloc(20 * 1024 * 1024 + 1, 1));
    expect(big.status, big.text).toBe(413);
    expect(big.body.code).toBe("ATTACHMENT_TOO_LARGE");
    expect(readdirSync(path.join(dir, ".tmp"))).toEqual([]);
  });

  it("上传中途取消不留下记录和临时文件", async () => {
    const { port, dir, upload } = await start();
    await new Promise<void>((resolve) => {
      const boundary = "----hive";
      const request = httpRequest({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/rooms/general/attachments",
        headers: {
          ...OWNER,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(5 * 1024 * 1024),
        },
      });
      request.on("error", () => resolve());
      request.write(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.bin"\r\n\r\n`,
      );
      request.write(Buffer.alloc(256 * 1024, 7));
      setTimeout(() => {
        request.destroy();
        resolve();
      }, 100);
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(readdirSync(path.join(dir, ".tmp"))).toEqual([]);
    expect(readdirSync(dir).filter((name) => name !== ".tmp")).toEqual([]);
    // 服务端仍正常
    expect((await upload("ok.txt", "ok")).status).toBe(201);
  });

  it("Agent 经 hive_attachment_read 读取文本分段与图片；未发出或撤回的读不到", async () => {
    const { base, upload, join, sendMessage } = await start();
    const owner = await join("rd", "human");
    await join("reader", "agent");
    const text = (await upload("notes.md", `${"中".repeat(10)}tail`)).body;
    const image = (await upload("shot.png", PNG)).body;
    const pending = (await upload("pending.txt", "draft")).body;
    const message = created(
      await sendMessage(owner, {
        clientMessageId: "m",
        content: "@reader 看附件",
        attachmentIds: [text.id, image.id],
      }),
    );

    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: {
        headers: { ...OWNER, "X-Hive-Room": "general", "X-Hive-Agent-Name": "reader" },
      },
    });
    const client = new Client({ name: "att-test", version: "0.1.0" });
    await client.connect(transport as unknown as Transport);

    // 每个汉字 3 字节：maxBytes=10 只能完整读到 3 个字，不截断字符
    const first = await client.callTool({
      name: "hive_attachment_read",
      arguments: { attachmentId: text.id, maxBytes: 10 },
    });
    const firstData = first.structuredContent as { text: string; nextOffset: number };
    expect(firstData.text).toBe("中中中");
    expect(firstData.nextOffset).toBe(9);
    const rest = await client.callTool({
      name: "hive_attachment_read",
      arguments: { attachmentId: text.id, offset: 9 },
    });
    expect(rest.structuredContent as { text: string; nextOffset: number | null }).toMatchObject({
      text: `${"中".repeat(7)}tail`,
      nextOffset: null,
    });

    const picture = await client.callTool({
      name: "hive_attachment_read",
      arguments: { attachmentId: image.id },
    });
    const content = picture.content as Array<{ type: string; data?: string; mimeType?: string }>;
    expect(content.find((part) => part.type === "image")).toEqual({
      type: "image",
      data: PNG.toString("base64"),
      mimeType: "image/png",
    });

    const notSent = await client.callTool({
      name: "hive_attachment_read",
      arguments: { attachmentId: pending.id },
    });
    expect(notSent.isError).toBe(true);

    owner.send({ type: "message.delete", messageId: message.id });
    await owner.next((event) => event.type === "message.deleted");
    const recalled = await client.callTool({
      name: "hive_attachment_read",
      arguments: { attachmentId: text.id },
    });
    expect(recalled.isError).toBe(true);
    await client.close();
  });

  it("本机房主 Agent 拿到 Server 存的文件路径；访客拿不到", async () => {
    const { app, upload, join, sendMessage, guest } = await start();
    const owner = await join("rd", "human");
    const item = (await upload("a.txt", "hello")).body;
    // 还没发出不提供路径
    const early = await app.inject({
      url: `/api/attachments/${item.id}/local-path`,
      headers: OWNER,
      remoteAddress: "127.0.0.1",
    });
    expect(early.statusCode).toBe(404);
    await sendMessage(owner, { clientMessageId: "m", attachmentIds: [item.id] });
    const local = await app.inject({
      url: `/api/attachments/${item.id}/local-path`,
      headers: OWNER,
      remoteAddress: "127.0.0.1",
    });
    expect(local.statusCode).toBe(200);
    expect(existsSync(local.json().path)).toBe(true);
    const remote = await app.inject({
      url: `/api/attachments/${item.id}/local-path`,
      headers: OWNER,
      remoteAddress: "203.0.113.9",
    });
    expect(remote.statusCode).toBe(403);
    const alice = await guest("alice");
    const viaGuest = await app.inject({
      url: `/api/attachments/${item.id}/local-path`,
      headers: alice.headers,
      remoteAddress: "127.0.0.1",
    });
    expect(viaGuest.statusCode).toBe(403);
  });

  describe("房间产物列表", () => {
    type Listing = {
      artifacts: Array<Record<string, any> & { versions?: Array<Record<string, any>> }>;
      nextCursor?: string;
      counts: Record<string, number>;
    };
    const list = async (
      base: string,
      query = "",
      headers: Record<string, string> = OWNER,
      roomId = "general",
    ) => {
      const response = await fetch(`${base}/api/rooms/${roomId}/attachments${query}`, { headers });
      return { status: response.status, body: (await response.json()) as Listing };
    };

    it("只列随消息发出的附件，新的在前；同一人同名文件归成一个产物带历史版本；权限同读消息，不含本机路径", async () => {
      const { base, upload, join, sendMessage, guest } = await start();
      const owner = await join("rd", "human");
      const agent = await join("rd-codex", "agent");
      const alice = await guest("alice");
      const outsider = await guest("eve", "secret");

      const pending = (await upload("draft.md", "# not sent")).body;
      const v1 = (await upload("report.md", "# v1")).body;
      created(await sendMessage(agent, { clientMessageId: "a1", attachmentIds: [v1.id] }));
      const shot = (await upload("shot.png", PNG)).body;
      const other = (await upload("Report.md", "# by rd")).body;
      created(
        await sendMessage(owner, { clientMessageId: "o1", attachmentIds: [shot.id, other.id] }),
      );
      const v2 = (await upload("REPORT.md", "# v2")).body;
      agent.send({ type: "message.send", clientMessageId: "a2", attachmentIds: [v2.id] });
      const m3 = created(
        await agent.next(
          (event) => event.type === "message.created" && event.message.clientMessageId === "a2",
        ),
      );

      const { status, body } = await list(base);
      expect(status).toBe(200);
      expect(body.artifacts.map((item) => item.id)).toEqual([v2.id, shot.id, other.id]);
      expect(body.artifacts.some((item) => item.id === pending.id)).toBe(false);
      expect(body.artifacts[0]).toMatchObject({
        name: "REPORT.md",
        category: "document",
        messageId: m3.id,
        messageSeq: m3.seq,
        senderName: "rd-codex",
        senderType: "agent",
      });
      expect(body.artifacts[0]!.versions?.map((item) => item.id)).toEqual([v1.id]);
      // 不同发送者的同名文件不归到一起
      expect(body.artifacts[2]!.versions).toBeUndefined();
      expect(body.artifacts[1]).toMatchObject({ category: "image", width: 1, height: 1 });
      expect(body.counts).toMatchObject({ all: 3, image: 1, file: 2, document: 2, code: 0 });
      expect(body.nextCursor).toBeUndefined();
      const raw = JSON.stringify(body);
      expect(raw).not.toContain("filePath");
      expect(raw).not.toContain(tmpdir());

      expect((await list(base, "", alice.headers)).body.artifacts).toHaveLength(3);
      expect((await list(base, "", outsider.headers)).status).toBe(403);
      expect((await list(base, "", {})).status).toBe(401);
      expect((await list(base, "", outsider.headers, "secret")).body.artifacts).toEqual([]);
      expect((await list(base, "?type=nope")).status).toBe(400);
    });

    it("撤回的消息不再列出；按类型、文件名筛选；游标分页不重不漏", async () => {
      const { base, upload, join, sendMessage } = await start();
      const owner = await join("rd", "human");
      const ids: string[] = [];
      for (const name of ["a.ts", "b.json", "c.zip", "d.png", "notes.txt", "e.ts"]) {
        const item = (await upload(name, name === "d.png" ? PNG : `content of ${name}`)).body;
        created(await sendMessage(owner, { clientMessageId: name, attachmentIds: [item.id] }));
        ids.unshift(item.id);
      }
      const recalled = (await upload("secret.ts", "oops")).body;
      const message = created(
        await sendMessage(owner, { clientMessageId: "r", attachmentIds: [recalled.id] }),
      );
      expect((await list(base)).body.artifacts[0]!.id).toBe(recalled.id);
      owner.send({ type: "message.delete", messageId: message.id });
      await owner.next((event) => event.type === "message.deleted");

      const all = (await list(base)).body;
      expect(all.artifacts.map((item) => item.id)).toEqual(ids);
      expect(all.counts).toMatchObject({ all: 6, image: 1, file: 5, code: 2, data: 1, archive: 1 });

      const code = (await list(base, "?type=code")).body.artifacts.map((item) => item.name);
      expect(code).toEqual(["e.ts", "a.ts"]);
      expect((await list(base, "?type=image")).body.artifacts.map((item) => item.name)).toEqual([
        "d.png",
      ]);
      expect((await list(base, "?type=file&q=NOTES")).body.artifacts.map((i) => i.name)).toEqual([
        "notes.txt",
      ]);
      // 搜索不影响各类型总数（筛选按钮上的数字）
      expect((await list(base, "?q=zzz")).body).toMatchObject({
        artifacts: [],
        counts: { all: 6 },
      });

      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = (
          await list(base, `?limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
        ).body;
        expect(page.artifacts.length).toBeLessThanOrEqual(4);
        seen.push(...page.artifacts.map((item) => item.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(ids);
      expect((await list(base, "?cursor=bad")).status).toBe(400);
    });

    it("按发送者、时间筛选：计数跟着范围变，发送者列表不受筛选影响", async () => {
      const { base, upload, join, sendMessage } = await start();
      const owner = await join("rd", "human");
      const agent = await join("rd-codex", "agent");
      for (const [who, name] of [
        [agent, "a.md"],
        [agent, "b.png"],
        [owner, "c.ts"],
      ] as const) {
        const item = (await upload(name, name.endsWith(".png") ? PNG : `content of ${name}`)).body;
        created(await sendMessage(who, { clientMessageId: name, attachmentIds: [item.id] }));
      }
      const all = (await list(base)).body as Listing & {
        senders: Array<{ id: string; name: string; type: string; count: number }>;
      };
      expect(all.senders.map((sender) => [sender.name, sender.type, sender.count])).toEqual([
        ["rd-codex", "agent", 2],
        ["rd", "human", 1],
      ]);
      const codex = all.senders[0]!.id;

      const byAgent = (await list(base, `?sender=${codex}`)).body as typeof all;
      expect(byAgent.artifacts.map((item) => item.name)).toEqual(["b.png", "a.md"]);
      expect(byAgent.counts).toMatchObject({ all: 2, image: 1, file: 1, code: 0 });
      expect(byAgent.senders).toHaveLength(2);
      expect(
        (await list(base, `?sender=${codex}&type=file`)).body.artifacts.map((item) => item.name),
      ).toEqual(["a.md"]);

      const future = encodeURIComponent(new Date(Date.now() + 60_000).toISOString());
      const past = encodeURIComponent(new Date(Date.now() - 60_000).toISOString());
      expect((await list(base, `?since=${future}`)).body).toMatchObject({
        artifacts: [],
        counts: { all: 0 },
      });
      expect((await list(base, `?since=${past}`)).body.artifacts).toHaveLength(3);
      expect((await list(base, "?sender=nope")).status).toBe(400);
      expect((await list(base, "?since=yesterday")).status).toBe(400);
    });
  });
});
