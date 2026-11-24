import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { Peer } from "./test-peer.js";

type Member = { username: string; workspace?: unknown };

describe("Agent 在本房间的工作目录", () => {
  it("加入时上报的目录写进成员信息（快照、上线广播、成员列表），格式不对时当作没报、不影响加入", async () => {
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

      const workspace = { cwd: "/code/proj", roomWorkspace: "~/code/proj", note: "说明" };
      const agent = await connect();
      agent.send({
        type: "participant.join",
        roomId: "general",
        token: "t",
        username: "reader",
        participantType: "agent",
        workspace,
      });
      const snapshot = (await agent.next((event) => event.type === "room.snapshot")) as {
        self: Member;
      };
      expect(snapshot.self.workspace).toEqual(workspace);
      const presence = (await human.next(
        (event) =>
          event.type === "presence.changed" &&
          (event as { participant: Member }).participant.username === "reader",
      )) as { participant: Member };
      expect(presence.participant.workspace).toEqual(workspace);

      const broken = await connect();
      broken.send({
        type: "participant.join",
        roomId: "general",
        token: "t",
        username: "old",
        participantType: "agent",
        workspace: { cwd: "" },
      });
      const brokenSnapshot = (await broken.next((event) => event.type === "room.snapshot")) as {
        self: Member;
      };
      expect(brokenSnapshot.self.workspace).toBeUndefined();

      const members = (
        await app.inject({
          method: "GET",
          url: "/api/rooms/general/participants",
          headers: { authorization: "Bearer t" },
        })
      ).json() as { participants: Member[] };
      const byName = new Map(members.participants.map((item) => [item.username, item]));
      expect(byName.get("reader")?.workspace).toEqual(workspace);
      expect(byName.get("rd")?.workspace).toBeUndefined();
    } finally {
      for (const peer of peers) peer.socket.close();
      await app.close();
    }
  });
});
