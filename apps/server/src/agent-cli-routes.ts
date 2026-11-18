import { serverText, agentCliToolSchema, upgradeAgentCliRequestSchema } from "@superhive/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { HiveError } from "./database.js";
import type { AgentCliManager } from "./agent-clis.js";
import type { LocalAgentSupervisor } from "./local-agents.js";
import { errorText, hiveErrorBody } from "./texts.js";

/**
 * 本机 Agent CLI 的检测与升级接口：只限本机房主（local 级，和运行时地址与密钥一样），
 * 房主的其他设备、Agent 的总令牌、别的电脑都拒绝。会在这台电脑上跑升级命令，所以命令不从请求里拿：
 * 请求只带页面确认过的那条命令，服务端重新算一遍，一字不差才执行。
 */

const ERROR_STATUS: Record<string, number> = {
  AGENT_CLI_BUSY: 409,
  AGENT_CLI_PLAN_CHANGED: 409,
  AGENT_CLI_NOT_UPGRADABLE: 409,
  AGENT_CLI_UP_TO_DATE: 409,
  AGENT_CLI_NODE_TOO_OLD: 409,
};

export function registerAgentCliRoutes(
  app: FastifyInstance,
  options: {
    manager: AgentCliManager | undefined;
    supervisor: LocalAgentSupervisor;
    /** 通过本机房主校验返回 true；不通过时已经发出了响应 */
    authorizeLocal: (request: FastifyRequest, reply: FastifyReply) => boolean;
  },
): void {
  const { manager, supervisor, authorizeLocal } = options;

  /** 用这个运行时的本机 Agent：升级完要重启它们才用上新版 */
  const agentsOf = (tool: string) =>
    supervisor
      .list()
      .filter((agent) => agent.provider === tool)
      .map((agent) => ({ id: agent.id, name: agent.name, status: agent.status }));

  const disabled = (reply: FastifyReply) =>
    reply.code(404).send({ ...errorText(serverText("error.feature.disabled")) });

  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof HiveError && ERROR_STATUS[error.code]) {
      return reply.code(ERROR_STATUS[error.code]!).send(hiveErrorBody(error));
    }
    throw error;
  };

  app.get<{ Querystring: { refresh?: string } }>(
    "/api/local/agent-clis",
    async (request, reply) => {
      if (!authorizeLocal(request, reply)) return reply;
      if (!manager) return disabled(reply);
      const tools = await manager.list(request.query.refresh === "1");
      return {
        tools: tools.map((tool) => ({ ...tool, agents: agentsOf(tool.tool) })),
        job: manager.current() ?? null,
      };
    },
  );

  app.post<{ Params: { tool: string } }>(
    "/api/local/agent-clis/:tool/upgrade",
    async (request, reply) => {
      if (!authorizeLocal(request, reply)) return reply;
      if (!manager) return disabled(reply);
      const tool = agentCliToolSchema.safeParse(request.params.tool);
      const body = upgradeAgentCliRequestSchema.safeParse(request.body);
      if (!tool.success || !body.success) {
        return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
      }
      try {
        const job = await manager.upgrade(tool.data, body.data.command);
        request.log.info(
          {
            agentCli: {
              by: "local-owner",
              ip: request.ip,
              action: "upgrade",
              tool: tool.data,
              command: job.command,
            },
          },
          "agent cli upgrade started",
        );
        return reply.code(202).send({ job, agents: agentsOf(tool.data) });
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/local/agent-clis/jobs/:id", async (request, reply) => {
    if (!authorizeLocal(request, reply)) return reply;
    if (!manager) return disabled(reply);
    const job = manager.job(request.params.id);
    if (!job) return reply.code(404).send({ ...errorText(serverText("error.request.invalid")) });
    return { job };
  });
}
