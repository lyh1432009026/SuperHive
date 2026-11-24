import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { buildApp } from "./app.js";
import { Peer } from "./test-peer.js";

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

async function start() {
  const app = await buildApp({
    databasePath: ":memory:",
    token: "test-token",
    staticDir: "/definitely-not-present",
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(() => app.close());
  const port = (app.server.address() as AddressInfo).port;
  const joinAgent = async (username: string) => {
    const peer = await Peer.connect(`ws://127.0.0.1:${port}/ws`);
    cleanup.push(() => peer.socket.close());
    peer.send({
      type: "participant.join",
      username,
      participantType: "agent",
      roomId: "general",
      token: "test-token",
    });
    await peer.next((event) => event.type === "room.snapshot");
  };
  const mcp = async (agentHeader: string) => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: {
        headers: {
          Authorization: "Bearer test-token",
          "X-Hive-Room": "general",
          "X-Hive-Agent-Name": agentHeader,
        },
      },
    });
    const client = new Client({ name: "hive-identity-test", version: "0.1.0" });
    await client.connect(transport as unknown as Transport);
    cleanup.push(() => client.close());
    return client;
  };
  return { joinAgent, mcp };
}

describe("Hive MCP 身份头", () => {
  it("中文名的 Agent 按 URI 编码发身份头，能正常连上并调用工具", async () => {
    const { joinAgent, mcp } = await start();
    await joinAgent("菜包-claude");
    // HTTP 头只能放 Latin-1：原样放中文名，Node 的 fetch 在发请求前就会抛错
    expect(() => new Headers({ "X-Hive-Agent-Name": "菜包-claude" })).toThrow();
    const client = await mcp(encodeURIComponent("菜包-claude"));
    const result = await client.callTool({ name: "hive_members_list", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("菜包-claude");
  });

  it("老客户端原样发的 ASCII 名字照常认", async () => {
    const { joinAgent, mcp } = await start();
    await joinAgent("helper");
    const client = await mcp("helper");
    const result = await client.callTool({ name: "hive_members_list", arguments: {} });
    expect(result.isError).toBeFalsy();
  });
});
