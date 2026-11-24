import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createPickFilesHandler,
  createWorkspaceLookup,
  dialogDefaultPath,
  mimeFor,
  normalizePickRequest,
  readPickedFiles,
  type FetchLike,
  type PickedFile,
} from "./file-picker.js";

const HOME = path.resolve("/home/me");
const WORKSPACE = path.resolve("/work/repo");

describe("normalizePickRequest", () => {
  it("只收形状正确的房间 ID，多选默认开", () => {
    expect(normalizePickRequest({ roomId: "build" })).toEqual({ roomId: "build", multiple: true });
    expect(normalizePickRequest({ roomId: "build", multiple: false })).toEqual({
      roomId: "build",
      multiple: false,
    });
    for (const roomId of ["../etc", "/tmp", "a b", "", 42, "x".repeat(65)])
      expect(normalizePickRequest({ roomId })).toEqual({ multiple: true });
    expect(normalizePickRequest(null)).toEqual({ multiple: true });
    // 网页传路径也没用：不认这个字段
    expect(normalizePickRequest({ defaultPath: "/etc", roomId: "build" })).toEqual({
      roomId: "build",
      multiple: true,
    });
  });
});

describe("dialogDefaultPath", () => {
  const dirs = new Set([WORKSPACE, path.join(HOME, "proj")]);
  const isDirectory = async (target: string) => dirs.has(target);

  it("工作区是存在的目录时用它", async () => {
    expect(await dialogDefaultPath({ workspace: WORKSPACE, home: HOME, isDirectory })).toBe(
      WORKSPACE,
    );
  });

  it("~ 开头展开成主目录", async () => {
    expect(await dialogDefaultPath({ workspace: "~/proj", home: HOME, isDirectory })).toBe(
      path.join(HOME, "proj"),
    );
  });

  it("没绑定、不存在、不是目录、相对路径、stat 出错：都退回主目录", async () => {
    for (const workspace of [undefined, "", "  ", path.resolve("/gone"), "relative/dir"])
      expect(await dialogDefaultPath({ workspace, home: HOME, isDirectory })).toBe(HOME);
    const failing = async () => {
      throw new Error("EACCES");
    };
    expect(
      await dialogDefaultPath({ workspace: WORKSPACE, home: HOME, isDirectory: failing }),
    ).toBe(HOME);
  });
});

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("createWorkspaceLookup", () => {
  const origin = "http://127.0.0.1:8787";

  it("先取本机凭证，再带着它查房间工作区；凭证缓存起来", async () => {
    const fetch = vi.fn<FetchLike>(async (url, init) => {
      if (url === `${origin}/api/local/session`)
        return jsonResponse(200, { enabled: true, mode: "local", ownerToken: "tok" });
      expect(init?.headers).toEqual({ "x-hive-owner": "tok" });
      return jsonResponse(200, { workspace: WORKSPACE });
    });
    const lookup = createWorkspaceLookup({ origin: () => origin, fetch });
    expect(await lookup("build")).toBe(WORKSPACE);
    expect(await lookup("build")).toBe(WORKSPACE);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${origin}/api/local/session`,
      `${origin}/api/local/rooms/build/workspace`,
      `${origin}/api/local/rooms/build/workspace`,
    ]);
  });

  it("Hive 重启换了凭证（401）重取一次", async () => {
    let token = "old";
    const fetch = vi.fn<FetchLike>(async (url, init) => {
      if (url.endsWith("/api/local/session"))
        return jsonResponse(200, { enabled: true, ownerToken: token });
      return init?.headers?.["x-hive-owner"] === "new"
        ? jsonResponse(200, { workspace: WORKSPACE })
        : jsonResponse(401, {});
    });
    const lookup = createWorkspaceLookup({ origin: () => origin, fetch });
    await lookup("build");
    token = "new";
    expect(await lookup("build")).toBe(WORKSPACE);
  });

  it("没绑定、没有地址、房间 ID 不对、本机会话关着、请求出错：都是 undefined", async () => {
    const unbound = createWorkspaceLookup({
      origin: () => origin,
      fetch: async (url) =>
        url.endsWith("/session")
          ? jsonResponse(200, { enabled: true, ownerToken: "t" })
          : jsonResponse(200, { workspace: null }),
    });
    expect(await unbound("build")).toBeUndefined();

    const never = vi.fn<FetchLike>();
    expect(await createWorkspaceLookup({ origin: () => undefined, fetch: never })("build")).toBe(
      undefined,
    );
    expect(await createWorkspaceLookup({ origin: () => origin, fetch: never })("../x")).toBe(
      undefined,
    );
    expect(never).not.toHaveBeenCalled();

    const disabled = createWorkspaceLookup({
      origin: () => origin,
      fetch: async () => jsonResponse(200, { enabled: false }),
    });
    expect(await disabled("build")).toBeUndefined();

    const broken = createWorkspaceLookup({
      origin: () => origin,
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(await broken("build")).toBeUndefined();
  });
});

describe("readPickedFiles", () => {
  const MB = 1024 * 1024;
  function io(sizes: Record<string, number | "dir">) {
    const readFile = vi.fn(async (file: string) => new Uint8Array(sizes[file] as number));
    return {
      readFile,
      stat: async (file: string) => {
        const size = sizes[file];
        if (size === undefined) throw new Error("ENOENT");
        return { size: size === "dir" ? 0 : size, isFile: () => size !== "dir" };
      },
    };
  }

  it("普通文件读出内容，带上扩展名对应的类型", async () => {
    const files = await readPickedFiles(
      ["/a/shot.PNG", "/a/notes.md"],
      io({
        "/a/shot.PNG": 3,
        "/a/notes.md": 5,
      }),
    );
    expect(
      files.map(({ name, type, size, data }) => ({ name, type, size, n: data?.length })),
    ).toEqual([
      { name: "shot.PNG", type: "image/png", size: 3, n: 3 },
      { name: "notes.md", type: "text/markdown", size: 5, n: 5 },
    ]);
  });

  it("超过 20 MB、合计超过 50 MB、超过 10 个的不读内容，只回名字和大小", async () => {
    const sizes: Record<string, number> = { "/big.bin": 21 * MB };
    for (let i = 0; i < 3; i += 1) sizes[`/m${i}.bin`] = 19 * MB;
    const fake = io(sizes);
    const files = await readPickedFiles(Object.keys(sizes), fake);
    const summary = (list: PickedFile[]) => list.map((f) => [f.name, f.skipped ?? "read"]);
    expect(summary(files)).toEqual([
      ["big.bin", "too-large"],
      ["m0.bin", "read"],
      ["m1.bin", "read"],
      ["m2.bin", "total"],
    ]);
    expect(fake.readFile).toHaveBeenCalledTimes(2);

    const many: Record<string, number> = {};
    for (let i = 0; i < 12; i += 1) many[`/f${i}.txt`] = 1;
    const result = await readPickedFiles(Object.keys(many), io(many));
    expect(result.filter((f) => f.data)).toHaveLength(10);
    expect(result.filter((f) => f.skipped === "count")).toHaveLength(2);
  });

  it("目录、读不到的跳过", async () => {
    const files = await readPickedFiles(
      ["/dir", "/gone", "/ok.txt"],
      io({
        "/dir": "dir",
        "/ok.txt": 1,
      }),
    );
    expect(files.map((f) => f.name)).toEqual(["ok.txt"]);
  });

  it("认不出的扩展名类型留空", () => {
    expect(mimeFor("/x/Makefile")).toBe("");
    expect(mimeFor("/x/a.JPEG")).toBe("image/jpeg");
  });
});

describe("createPickFilesHandler", () => {
  type Event = { sender: { id: number }; ok: boolean };
  function setup(overrides: Partial<Parameters<typeof createPickFilesHandler<Event>>[0]> = {}) {
    const showDialog = vi.fn(async () => ({ canceled: false, filePaths: ["/w/a.txt"] }));
    const readFiles = vi.fn(async (paths: readonly string[]) =>
      paths.map((p) => ({
        name: path.basename(p),
        type: "text/plain",
        size: 1,
        data: new Uint8Array(1),
      })),
    );
    const roomWorkspace = vi.fn(async () => WORKSPACE);
    const handler = createPickFilesHandler<Event>({
      trusted: (event) => event.ok,
      roomWorkspace,
      home: () => HOME,
      isDirectory: async (target) => target === WORKSPACE,
      title: () => "添加附件",
      showDialog,
      readFiles,
      ...overrides,
    });
    return { handler, showDialog, readFiles, roomWorkspace };
  }

  it("不可信来源直接拒绝，不开对话框", async () => {
    const { handler, showDialog } = setup();
    await expect(handler({ sender: { id: 1 }, ok: false }, { roomId: "build" })).rejects.toThrow(
      "Forbidden",
    );
    expect(showDialog).not.toHaveBeenCalled();
  });

  it("起始目录是主进程查到的工作区，标题和多选照传", async () => {
    const { handler, showDialog, roomWorkspace } = setup();
    const result = await handler({ sender: { id: 1 }, ok: true }, { roomId: "build" });
    expect(roomWorkspace).toHaveBeenCalledWith("build");
    expect(showDialog).toHaveBeenCalledWith(expect.anything(), {
      title: "添加附件",
      defaultPath: WORKSPACE,
      multiple: true,
    });
    expect(result.canceled).toBe(false);
    expect(result.files.map((f) => f.name)).toEqual(["a.txt"]);
  });

  it("没有房间、工作区查不到或不是目录：起始目录是主目录", async () => {
    const { handler, showDialog, roomWorkspace } = setup({
      roomWorkspace: vi.fn(async () => path.resolve("/not/a/dir")),
    });
    await handler({ sender: { id: 1 }, ok: true }, {});
    expect(roomWorkspace).not.toHaveBeenCalled();
    await handler({ sender: { id: 1 }, ok: true }, { roomId: "build" });
    expect(showDialog.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      { title: "添加附件", defaultPath: HOME, multiple: true },
      { title: "添加附件", defaultPath: HOME, multiple: true },
    ]);
  });

  it("取消、或者对话框关上时页面已经不可信：什么都不读", async () => {
    const canceled = setup({ showDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) });
    expect(await canceled.handler({ sender: { id: 1 }, ok: true }, {})).toEqual({
      canceled: true,
      files: [],
    });
    expect(canceled.readFiles).not.toHaveBeenCalled();

    const event: Event = { sender: { id: 1 }, ok: true };
    const navigated = setup({
      showDialog: vi.fn(async () => {
        event.ok = false;
        return { canceled: false, filePaths: ["/w/a.txt"] };
      }),
    });
    expect(await navigated.handler(event, {})).toEqual({ canceled: true, files: [] });
    expect(navigated.readFiles).not.toHaveBeenCalled();
  });

  it("同一页面已经开着对话框时不叠第二个", async () => {
    type Picked = { canceled: boolean; filePaths: string[] };
    let release!: (value: Picked) => void;
    const showDialog = vi.fn(() => new Promise<Picked>((resolve) => (release = resolve)));
    const { handler } = setup({ showDialog });
    const first = handler({ sender: { id: 1 }, ok: true }, {});
    await vi.waitFor(() => expect(showDialog).toHaveBeenCalledTimes(1));
    expect(await handler({ sender: { id: 1 }, ok: true }, {})).toEqual({
      canceled: true,
      files: [],
    });
    release({ canceled: true, filePaths: [] });
    await first;
    // 关上之后可以再开
    const again = handler({ sender: { id: 1 }, ok: true }, {});
    await vi.waitFor(() => expect(showDialog).toHaveBeenCalledTimes(2));
    release({ canceled: true, filePaths: [] });
    await again;
  });
});
