import {
  putRuntimeMcpServerRequestSchema,
  runtimeCredentialProviderSchema,
  serverText,
  updateRuntimeConfigFieldsRequestSchema,
  updateRuntimeConfigFileRequestSchema,
  type RuntimeCredentialProvider,
} from "@superhive/protocol";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { HiveError } from "./database.js";
import type { LocalAgentSupervisor } from "./local-agents.js";
import { RuntimeConfigStore } from "./runtime-config.js";
import type { RuntimeCredentialStore } from "./runtime-credentials.js";
import { errorText, hiveErrorBody } from "./texts.js";

/**
 * Agent CLI 配置面板的接口：只限本机房主（local 级，和运行时地址与密钥一样），
 * 房主的其他设备、Agent 的总令牌、别的电脑都拒绝。原始配置里有密钥，整份原文要单独确认后才取（POST），
 * 响应不缓存；审计只记谁、哪个运行时、改了哪一项或哪个文件，不记值。
 */

const ERROR_STATUS: Record<string, number> = {
  RUNTIME_CREDENTIALS_NOT_EDITABLE: 409,
  RUNTIME_CREDENTIALS_UNREADABLE: 409,
  RUNTIME_CREDENTIALS_WRITE_FAILED: 500,
  RUNTIME_CONFIG_INVALID: 400,
  RUNTIME_CONFIG_CHANGED: 409,
};

export function registerRuntimeConfigRoutes(
  app: FastifyInstance,
  options: {
    credentials: RuntimeCredentialStore | undefined;
    supervisor: LocalAgentSupervisor;
    /** 通过本机房主校验返回 true；不通过时已经发出了响应 */
    authorizeLocal: (request: FastifyRequest, reply: FastifyReply) => boolean;
  },
): void {
  const { credentials, supervisor, authorizeLocal } = options;
  const store = credentials ? new RuntimeConfigStore(credentials) : undefined;

  const agentsOf = (provider: RuntimeCredentialProvider) =>
    supervisor
      .list()
      .filter((agent) => agent.provider === provider)
      .map((agent) => ({ id: agent.id, name: agent.name, status: agent.status }));
  const contextOf = (provider: RuntimeCredentialProvider) => ({
    cwds: [
      ...new Set(
        supervisor
          .list()
          .filter((agent) => agent.provider === provider && agent.cwd)
          .map((agent) => agent.cwd!),
      ),
    ],
  });

  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof HiveError && ERROR_STATUS[error.code]) {
      return reply.code(ERROR_STATUS[error.code]!).send(hiveErrorBody(error));
    }
    throw error;
  };
  const badRequest = (reply: FastifyReply) =>
    reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });

  function audit(
    request: FastifyRequest,
    action: "view" | "update" | "delete",
    provider: RuntimeCredentialProvider,
    target: string[],
  ) {
    request.log.info(
      { runtimeConfig: { by: "local-owner", ip: request.ip, action, provider, target } },
      "runtime config " + action,
    );
  }

  /** 校验并取出运行时；不通过时已经发出响应 */
  function begin(
    request: FastifyRequest<{ Params: { provider: string } }>,
    reply: FastifyReply,
  ): { store: RuntimeConfigStore; provider: RuntimeCredentialProvider } | undefined {
    if (!authorizeLocal(request, reply)) return undefined;
    if (!store) {
      void reply.code(404).send({ ...errorText(serverText("error.feature.disabled")) });
      return undefined;
    }
    const provider = runtimeCredentialProviderSchema.safeParse(request.params.provider);
    if (!provider.success) {
      void badRequest(reply);
      return undefined;
    }
    return { store, provider: provider.data };
  }

  /** 改完返回最新配置，并带上要重启的本机 Agent */
  const result = (store: RuntimeConfigStore, provider: RuntimeCredentialProvider) => ({
    config: store.get(provider, contextOf(provider)),
    agents: agentsOf(provider),
  });

  app.get<{ Params: { provider: string } }>(
    "/api/local/runtime-config/:provider",
    async (request, reply) => {
      const ok = begin(request, reply);
      if (!ok) return reply;
      try {
        return result(ok.store, ok.provider);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.put<{ Params: { provider: string } }>(
    "/api/local/runtime-config/:provider/fields",
    async (request, reply) => {
      const ok = begin(request, reply);
      if (!ok) return reply;
      const body = updateRuntimeConfigFieldsRequestSchema.safeParse(request.body);
      if (!body.success || !Object.keys(body.data.values).length) return badRequest(reply);
      try {
        const changed = ok.store.updateFields(ok.provider, body.data.values);
        audit(request, "update", ok.provider, changed);
        return result(ok.store, ok.provider);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.put<{ Params: { provider: string } }>(
    "/api/local/runtime-config/:provider/mcp",
    async (request, reply) => {
      const ok = begin(request, reply);
      if (!ok) return reply;
      const body = putRuntimeMcpServerRequestSchema.safeParse(request.body);
      if (!body.success) return badRequest(reply);
      try {
        ok.store.putMcp(ok.provider, body.data.name, body.data.server, body.data.previousName);
        audit(request, "update", ok.provider, [`mcp:${body.data.name}`]);
        return result(ok.store, ok.provider);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.delete<{ Params: { provider: string; name: string } }>(
    "/api/local/runtime-config/:provider/mcp/:name",
    async (request, reply) => {
      const ok = begin(request, reply);
      if (!ok) return reply;
      try {
        ok.store.deleteMcp(ok.provider, request.params.name);
        audit(request, "delete", ok.provider, [`mcp:${request.params.name}`]);
        return result(ok.store, ok.provider);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.post<{ Params: { provider: string; name: string } }>(
    "/api/local/runtime-config/:provider/mcp/:name/toggle",
    async (request, reply) => {
      const ok = begin(request, reply);
      if (!ok) return reply;
      const body = z.object({ enabled: z.boolean() }).safeParse(request.body);
      if (!body.success) return badRequest(reply);
      try {
        ok.store.toggleMcp(ok.provider, request.params.name, body.data.enabled);
        audit(request, "update", ok.provider, [`mcp:${request.params.name}:enabled`]);
        return result(ok.store, ok.provider);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /** 整份文件原文：提示词或原始配置。原始配置里有密钥，页面在确认后才调 */
  app.post<{ Params: { provider: string; file: string } }>(
    "/api/local/runtime-config/:provider/files/:file/read",
    async (request, reply) => {
      const ok = begin(request, reply);
      if (!ok) return reply;
      try {
        const file = ok.store.readFile(ok.provider, request.params.file);
        audit(request, "view", ok.provider, [`file:${request.params.file}`]);
        void reply.header("Cache-Control", "no-store");
        return file;
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.put<{ Params: { provider: string; file: string } }>(
    "/api/local/runtime-config/:provider/files/:file",
    async (request, reply) => {
      const ok = begin(request, reply);
      if (!ok) return reply;
      const body = updateRuntimeConfigFileRequestSchema.safeParse(request.body);
      if (!body.success) return badRequest(reply);
      try {
        const { hash } = ok.store.writeFile(
          ok.provider,
          request.params.file,
          body.data.content,
          body.data.baseHash,
        );
        audit(request, "update", ok.provider, [`file:${request.params.file}`]);
        return { ...result(ok.store, ok.provider), hash };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
}
