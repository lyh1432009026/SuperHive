import type { Participant } from "@superhive/protocol";
import { t } from "./i18n";
import { MemberBadge } from "./member-badge";

/** 悬停说明：少了哪些能力、常见原因、怎么处理 */
export function memberHiveToolsHint(participant: Participant): string | undefined {
  const tools = participant.hiveTools;
  if (participant.type !== "agent" || tools?.status !== "unavailable") return undefined;
  const base = t(
    "{0} 连不上 Hive 工具（MCP）：读不到附件和图片、看不到白板、不能委派，回复仍由 Bridge 代发。升级到最新版并重启这个 Agent；仍不行请查看它的日志。",
    { 0: participant.username },
  );
  return tools.detail ? `${base}\n${t("原因：{0}", { 0: tools.detail })}` : base;
}

/** 成员名旁的醒目标记：Agent 的 Hive 工具连不上时显示，不能悄无声息地少了工具 */
export function MemberHiveToolsBadge({ participant }: { participant: Participant }) {
  const hint = memberHiveToolsHint(participant);
  if (!hint) return null;
  return (
    <MemberBadge level="danger" hint={hint}>
      {t("工具未连上")}
    </MemberBadge>
  );
}
