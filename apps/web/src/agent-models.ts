import { useEffect, useRef, useState } from "react";
import type { LocalAgent, LocalAgentModelsResponse, Participant } from "@superhive/protocol";

/** 每种运行时能选的模型（服务端按运行时缓存）：用来把模型 id 换成名称、找出运行时自己的默认模型 */
export type RuntimeModelLists = ReadonlyMap<string, LocalAgentModelsResponse>;

/**
 * 本机 Agent 用到的每种运行时各拉一次模型列表（借该运行时任一 Agent 的接口，服务端按运行时缓存，
 * 不会每个 Agent 都跑一遍 CLI）。拉不到的就没有，显示时退回模型 id。
 */
export function useRuntimeModels(
  agents: ReadonlyArray<Pick<LocalAgent, "id" | "provider">>,
  load: ((id: string) => Promise<LocalAgentModelsResponse>) | undefined,
): RuntimeModelLists {
  const [lists, setLists] = useState<Map<string, LocalAgentModelsResponse>>(() => new Map());
  // 每种运行时取第一个 Agent：provider 集合不变就不重拉
  const firstByProvider = new Map<string, string>();
  for (const agent of agents) {
    if (!firstByProvider.has(agent.provider)) firstByProvider.set(agent.provider, agent.id);
  }
  const key = [...firstByProvider.keys()].sort().join(",");
  // 接口函数每次渲染可能是新的：只在运行时集合变了时重拉
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const load = loadRef.current;
    if (!load || !key) return;
    let cancelled = false;
    for (const [provider, id] of firstByProvider) {
      load(id).then(
        (list) => {
          if (cancelled || !list.models.length) return;
          setLists((current) => new Map(current).set(provider, list));
        },
        () => undefined,
      );
    }
    return () => {
      cancelled = true;
    };
    // firstByProvider 由 key 决定
  }, [key]);
  return lists;
}

/** Claude 的完整模型 id 没有现成名称：claude-opus-5-5[1m] → Opus 5.5 (1M) */
function claudeName(id: string): string | undefined {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(id);
  if (!match) return undefined;
  const family = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1).toLowerCase();
  const version = match[3] ? `${match[2]}.${match[3]}` : match[2];
  return `${family} ${version}${match[4] ? " (1M)" : ""}`;
}

/** 模型的显示名：列表里有名称用名称，Claude 的完整 id 换成「Opus 5.5」，都不行就是 id 本身 */
export function modelDisplayName(id: string, list?: LocalAgentModelsResponse): string {
  const label = list?.models.find((model) => model.id === id)?.label?.trim();
  return label || claudeName(id) || id;
}

/**
 * 成员在用的模型：这个房间上一轮实际用的（运行时报的，Hive 重启后也在）；没回复过就用本机 Agent 设置里选的；
 * 设置是「运行时默认」就用运行时列出的默认模型；都不知道返回 undefined
 */
export function memberModel(
  participant: Pick<Participant, "username" | "provider" | "lastModel">,
  localAgents: ReadonlyArray<Pick<LocalAgent, "name" | "model" | "provider">>,
  lists: RuntimeModelLists,
): { id: string; name: string } | undefined {
  const name = participant.username.toLocaleLowerCase();
  const local = localAgents.find((agent) => agent.name.toLocaleLowerCase() === name);
  const provider = local?.provider ?? participant.provider;
  const list = provider ? lists.get(provider) : undefined;
  const id =
    participant.lastModel?.id ||
    local?.model ||
    (local ? list?.models.find((model) => model.isDefault)?.id : undefined);
  return id ? { id, name: modelDisplayName(id, list) } : undefined;
}
