import {
  artifactCategory,
  artifactCategorySchema,
  artifactGroupKey,
  matchesArtifactFilter,
  type Artifact,
  type ArtifactCounts,
  type ArtifactItem,
  type ArtifactSender,
  type ArtifactsQuery,
  type ArtifactsResponse,
} from "@superhive/protocol";
import type { SentAttachment } from "./attachment-store.js";

/**
 * 房间「产物」列表：把已发出的附件按「发送者 + 文件名」归成产物，最新版代表这个产物，
 * 再按类型、文件名筛选并分页。
 *
 * 一个房间的附件受配额限制（默认 1 GB），行数有限，每次请求在内存里整体归组；
 * 这样版本归组跨页也不会被切开，游标也不依赖数据库里的排序细节。
 */
export function listRoomArtifacts(
  sent: readonly SentAttachment[],
  query: ArtifactsQuery,
): ArtifactsResponse {
  // sent 已按消息新到旧排好，每组第一次出现的就是最新版
  const groups = new Map<string, ArtifactItem[]>();
  for (const attachment of sent) {
    const item: ArtifactItem = { ...attachment, category: artifactCategory(attachment) };
    const key = artifactGroupKey(item.senderId, item.name);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const artifacts: Artifact[] = [...groups.values()].map(([latest, ...versions]) =>
    versions.length > 0 ? { ...latest!, versions } : latest!,
  );

  const senders = new Map<string, ArtifactSender>();
  for (const artifact of artifacts) {
    const sender = senders.get(artifact.senderId);
    if (sender) sender.count += 1;
    else
      senders.set(artifact.senderId, {
        id: artifact.senderId,
        name: artifact.senderName,
        type: artifact.senderType,
        count: 1,
      });
  }

  // 发送者、时间是范围：计数跟着变；类型、搜索词不影响计数，筛选按钮上的数字不会跳
  const since = query.since ? Date.parse(query.since) : undefined;
  const scoped = artifacts.filter(
    (artifact) =>
      (!query.sender || artifact.senderId === query.sender) &&
      (since === undefined || Date.parse(artifact.createdAt) >= since),
  );
  const counts: ArtifactCounts = {};
  for (const filter of ["all", "file", ...artifactCategorySchema.options] as const) {
    counts[filter] = scoped.filter((artifact) =>
      matchesArtifactFilter(artifact.category, filter),
    ).length;
  }

  const needle = query.q.normalize("NFKC").toLocaleLowerCase();
  const matched = scoped.filter(
    (artifact) =>
      matchesArtifactFilter(artifact.category, query.type) &&
      (!needle ||
        [artifact, ...(artifact.versions ?? [])].some((item) =>
          item.name.normalize("NFKC").toLocaleLowerCase().includes(needle),
        )),
  );

  let start = 0;
  if (query.cursor) {
    const [seqText, id] = query.cursor.split(".") as [string, string];
    const at = matched.findIndex((artifact) => artifact.id === id);
    // 游标那一项在两次请求之间被撤回或有了新版本：从比它早的消息接着往下
    start =
      at >= 0
        ? at + 1
        : (() => {
            const index = matched.findIndex((artifact) => artifact.messageSeq < Number(seqText));
            return index < 0 ? matched.length : index;
          })();
  }
  const page = matched.slice(start, start + query.limit);
  const last = page.at(-1);
  return {
    artifacts: page,
    ...(last && start + page.length < matched.length
      ? { nextCursor: `${last.messageSeq}.${last.id}` }
      : {}),
    counts,
    senders: [...senders.values()].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name),
    ),
  };
}
