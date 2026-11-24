import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { Peer } from "./test-peer.js";

type Member = { username: string; hiveTools?: { status: string; detail?: string; at: string } };

describe("Agent 的 Hive 工具连不上", () => {
  it("Agent 报连不上时写进成员信息并广播，连上后清掉；人不能冒充上报", async () => {
    const app = await buildApp({ databasePath: ":memory:", token: "t", staticDir: "/nope" });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const peers: Peer[] = [];
    try {
      const port = (app.server.address() as { port: number }).port;
      const connect = async () => {
        const peer = await Peer.connect(`ws://127.0.0.1:${port}/ws`);
        peers.push(peer);
        return peer;
      };
      const human = await connect();
      human.send({
        type: "participant.join",
        roomId: "general",
        token: "t",
        username: "rd",
        participantType: "human",
      });
      await human.next((event) => event.type === "room.snapshot");

      const agent = await connect();
      agent.send({
        type: "participant.join",
        roomId: "general",
        token: "t",
        username: "菜包-claude",
        participantType: "agent",
      });
      const snapshot = (await agent.next((event) => event.type === "room.snapshot")) as {
        features: string[];
      };
      // Bridge 据此判断服务端认不认 agent.tools
      expect(snapshot.features).toContain("tools");
      await human.next(
        (event) =>
          event.type === "presence.changed" &&
          (event as { participant: Member }).participant.username === "菜包-claude",
      );

      const fromAgent = (event: { type: string }) =>
        event.type === "presence.changed" &&
        (event as unknown as { participant: Member }).participant.username === "菜包-claude";

      agent.send({
        type: "agent.tools",
        hive: "unavailable",
        detail: "Claude Code 报告 hive MCP 状态为 failed",
      });
      const down = (await human.next(fromAgent)) as { participant: Member };
      expect(down.participant.hiveTools).toMatchObject({
        status: "unavailable",
        detail: "Claude Code 报告 hive MCP 状态为 failed",
      });

      const members = (
        await app.inject({
          method: "GET",
          url: "/api/rooms/general/participants",
          headers: { authorization: "Bearer t" },
        })
      ).json() as { participants: Member[] };
      const byName = new Map(members.participants.map((item) => [item.username, item]));
      expect(byName.get("菜包-claude")?.hiveTools?.status).toBe("unavailable");
      expect(byName.get("rd")?.hiveTools).toBeUndefined();

      // 人发的不算：成员信息不变、不广播
      human.send({ type: "agent.tools", hive: "unavailable" });

      agent.send({ type: "agent.tools", hive: "connected" });
      const up = (await human.next(fromAgent)) as { participant: Member };
      expect(up.participant.hiveTools).toBeUndefined();
      const rd = (
        (
          await app.inject({
            method: "GET",
            url: "/api/rooms/general/participants",
            headers: { authorization: "Bearer t" },
          })
        ).json() as { participants: Member[] }
      ).participants.find((item) => item.username === "rd");
      expect(rd?.hiveTools).toBeUndefined();
    } finally {
      for (const peer of peers) peer.socket.close();
      await app.close();
    }
  });
});
