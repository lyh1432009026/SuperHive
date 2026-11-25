import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_NO_PROXY,
  parseProxyUrl,
  type LocalAgent,
  type NetworkProxyMode,
  type NetworkProxySettings,
  type NetworkProxyState,
  type ProxyUrlProblem,
} from "@superhive/protocol";
import { Icon } from "./app-icons";
import { Button } from "./button";
import { localized, t } from "./i18n";
import type { LocalAgentsState } from "./local-agents";

const MODES: ReadonlyArray<{ value: NetworkProxyMode; label: () => string; hint: () => string }> = [
  {
    value: "system",
    label: () => t("跟随系统"),
    hint: () => t("沿用启动 Hive 时终端里的代理变量；没有就用系统设置里的代理（推荐）"),
  },
  {
    value: "manual",
    label: () => t("手动"),
    hint: () => t("填一个代理地址，例如 Clash、v2rayN 的本地端口"),
  },
  {
    value: "none",
    label: () => t("不用代理"),
    hint: () => t("Agent 一律直连，忽略终端和系统里的代理设置"),
  },
];

const problemText: Record<ProxyUrlProblem, string> = localized(() => ({
  empty: t("先填代理地址"),
  invalid: t("地址格式不对"),
  scheme: t("只支持 http://、https://、socks5://、socks5h://、socks4://"),
  host: t("缺少主机名"),
  port: t("要写端口，例如 http://127.0.0.1:7890"),
  path: t("代理地址不能带路径或参数"),
}));

const sourceText: Record<NetworkProxyState["effective"]["source"], string> = localized(() => ({
  env: t("来自启动 Hive 时的环境变量"),
  system: t("来自系统代理设置"),
  manual: t("手动填写"),
  none: t("直连"),
}));

/** 设置改过之后才启动的不算；正在跑、启动时间早于上次改设置的要重启才用上新设置 */
export function agentsOnOldProxy(
  agents: readonly LocalAgent[],
  updatedAt: string | undefined,
): LocalAgent[] {
  if (!updatedAt) return [];
  const changed = Date.parse(updatedAt);
  return agents.filter(
    (agent) =>
      (agent.status === "running" || agent.status === "starting") &&
      agent.startedAt !== null &&
      Date.parse(agent.startedAt) < changed,
  );
}

/** 设置 · 这台电脑 · 网络代理：本机 Agent 子进程走不走代理 */
export function NetworkProxySettingsGroup({ local }: { local: LocalAgentsState }) {
  const { enabled, networkProxy } = local;
  const [state, setState] = useState<NetworkProxyState>();
  const [url, setUrl] = useState("");
  const [noProxy, setNoProxy] = useState("");
  const [status, setStatus] = useState<{ kind: "saving" | "saved" | "error"; text?: string }>();
  const [restarting, setRestarting] = useState(false);

  const load = useCallback(
    (next: NetworkProxyState) => {
      setState(next);
      setUrl(next.url ?? "");
      setNoProxy(next.noProxy ?? "");
    },
    [setState],
  );
  useEffect(() => {
    if (!enabled) return;
    networkProxy().then(load, () => setState(undefined));
  }, [enabled, networkProxy, load]);

  if (!enabled || !state) return null;
  const disabled = !local.canManage;
  const urlCheck = url.trim() ? parseProxyUrl(url) : undefined;
  const urlProblem = urlCheck && !urlCheck.ok ? problemText[urlCheck.problem] : undefined;
  const socks = urlCheck?.ok && urlCheck.socks;
  const stale = agentsOnOldProxy(local.agents, state.updatedAt);

  const save = (patch: Partial<NetworkProxySettings>) => {
    setStatus({ kind: "saving" });
    local.updateNetworkProxy(patch).then(
      (next) => {
        load(next);
        setStatus({ kind: "saved" });
      },
      (reason: unknown) =>
        setStatus({
          kind: "error",
          text: reason instanceof Error ? reason.message : String(reason),
        }),
    );
  };
  const chooseMode = (mode: NetworkProxyMode) => {
    if (mode === state.mode) return;
    // 手动但还没填地址：先切过去等人填，填好了（回车或离开输入框）再存
    if (mode === "manual" && !state.url && !url.trim()) {
      setState({ ...state, mode });
      setStatus(undefined);
      return;
    }
    save(mode === "manual" ? { mode, url: url.trim() || state.url! } : { mode });
  };
  const commitManual = () => {
    if (!urlCheck?.ok) {
      if (!url.trim()) setStatus({ kind: "error", text: problemText.empty });
      return;
    }
    const nextNoProxy = noProxy.trim();
    if (state.url === url.trim() && (state.noProxy ?? "") === nextNoProxy && state.updatedAt)
      return;
    save({ mode: "manual", url: url.trim(), noProxy: nextNoProxy });
  };
  const restartAll = () => {
    setRestarting(true);
    Promise.all(stale.map((agent) => local.act(agent.id, "restart")))
      .catch((reason: unknown) =>
        setStatus({
          kind: "error",
          text: reason instanceof Error ? reason.message : String(reason),
        }),
      )
      .finally(() => setRestarting(false));
  };

  const effective = state.effective;
  return (
    <div className="settings-group network-proxy-settings" id="settings-network-proxy">
      <div className="settings-section-heading">
        <div>
          <h4>{t("网络代理")}</h4>
          <p>
            {t(
              "只影响 Hive 在这台电脑上启动的 Agent（以及它们调用的 claude、agy 等命令行工具），不改系统设置。连不上海外的模型服务时在这里设置。",
            )}
          </p>
        </div>
      </div>
      <div
        className="shortcut-selector notification-modes"
        role="radiogroup"
        aria-label={t("网络代理")}
      >
        {MODES.map((mode) => (
          <button
            key={mode.value}
            type="button"
            role="radio"
            aria-checked={state.mode === mode.value}
            className={state.mode === mode.value ? "active" : ""}
            disabled={disabled}
            onClick={() => chooseMode(mode.value)}
          >
            <span>
              <strong>{mode.label()}</strong>
              <small>{mode.hint()}</small>
            </span>
            <i aria-hidden="true">
              <Icon name="check" size={14} />
            </i>
          </button>
        ))}
      </div>
      {state.mode === "manual" && (
        <div className="network-proxy-fields">
          <label>
            <span>{t("代理地址")}</span>
            <input
              className="model-picker-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="http://127.0.0.1:7890"
              value={url}
              disabled={disabled}
              aria-invalid={Boolean(urlProblem)}
              onChange={(event) => setUrl(event.target.value)}
              onBlur={commitManual}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                commitManual();
              }}
            />
          </label>
          {urlProblem && <p className="settings-note error">{urlProblem}</p>}
          {socks && (
            <p className="settings-note warning">
              {t(
                "Claude Code 和用 Node 写的 CLI（Gemini、Copilot 等）不支持 socks 代理，会连不上；能填 http 地址就填 http。Clash 等的混合端口两种都支持。",
              )}
            </p>
          )}
          <label>
            <span>{t("不走代理的地址（NO_PROXY）")}</span>
            <input
              className="model-picker-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder={DEFAULT_NO_PROXY}
              value={noProxy}
              disabled={disabled}
              onChange={(event) => setNoProxy(event.target.value)}
              onBlur={commitManual}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                commitManual();
              }}
            />
          </label>
          <p className="settings-note">
            {t(
              "逗号分隔。本机回环地址（localhost、127.0.0.1、::1）和 Hive 自己的地址总会直连，不用写。",
            )}
          </p>
        </div>
      )}
      <p className="network-proxy-effective" role="status">
        <strong>
          {effective.url
            ? t("Agent 将使用 {0}", { 0: effective.url })
            : t("Agent 将直连，不用代理")}
        </strong>
        {effective.url ? t("（{0}）", { 0: sourceText[effective.source] }) : ""}
      </p>
      {state.mode === "system" && !effective.url && (
        <p className="settings-note">
          {state.system.pac
            ? t(
                "系统用的是自动代理配置（PAC），读不出具体地址。需要代理的话改用「手动」，填代理软件的本地端口。",
              )
            : state.system.supported
              ? t(
                  "终端环境变量和系统设置里都没有代理。代理软件开了「系统代理」后，重启 Agent 即可用上。",
                )
              : t(
                  "这个系统读不了系统代理设置。可以在启动 Hive 的终端里设置 HTTPS_PROXY，或改用「手动」。",
                )}
        </p>
      )}
      <div className="network-proxy-restart">
        <p className="settings-note">
          {stale.length
            ? t("改动从下一次启动 Agent 开始生效；有 {0} 个正在运行的 Agent 还在用之前的设置。", {
                0: stale.length,
              })
            : t("改动从下一次启动 Agent 开始生效，已运行的 Agent 需要重启。")}
        </p>
        {stale.length > 0 && (
          <Button size="sm" disabled={disabled || restarting} onClick={restartAll}>
            {restarting ? t("重启中…") : t("重启全部本机 Agent")}
          </Button>
        )}
      </div>
      {stale.length > 0 && (
        <p className="settings-note">
          {t("会等每个 Agent 手上的任务做完再重启，不打断正在做的事。")}
        </p>
      )}
      {status && (
        <p className={`settings-note${status.kind === "error" ? " error" : ""}`} role="status">
          {status.kind === "saving"
            ? t("保存中…")
            : status.kind === "saved"
              ? t("已保存。")
              : t("保存失败：{0}", { 0: status.text ?? "" })}
        </p>
      )}
    </div>
  );
}
