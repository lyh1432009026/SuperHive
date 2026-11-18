import type { ReactNode } from "react";
import { t } from "./i18n";
import type { LocalAgentsState } from "./local-agents";
import { RuntimeCredentialsGroup } from "./runtime-credentials";

/**
 * 设置里的「Agent 运行时」：管理这台电脑上各 Agent CLI 的设置，只给本机房主（调用方按 local.mode 判断）。
 * 由多个独立区块组成，每块自己取数据、自己报错；要加新区块（例如已安装 CLI 的检测与升级），
 * 往 blocks 里加一项即可。
 */

type RuntimeBlock = { id: string; render: (local: LocalAgentsState) => ReactNode };

const blocks: RuntimeBlock[] = [
  { id: "credentials", render: (local) => <RuntimeCredentialsGroup api={local} /> },
];

export function AgentRuntimesPanel({ local }: { local: LocalAgentsState }) {
  return (
    <section id="settings-panel-runtimes" role="tabpanel" aria-label={t("Agent 运行时")}>
      <div className="settings-panel-heading">
        <h3>{t("Agent 运行时")}</h3>
        <p>
          {t(
            "这台电脑上 Claude Code、Codex 等 CLI 自己的设置，对用它们的所有 Agent 和终端里的 CLI 都生效。只有在运行 Hive Server 的这台电脑上打开网页时才能看到。",
          )}
        </p>
      </div>
      <div className="agent-runtime-blocks">
        {blocks.map((block) => (
          <div key={block.id} className="agent-runtime-block">
            {block.render(local)}
          </div>
        ))}
      </div>
    </section>
  );
}
