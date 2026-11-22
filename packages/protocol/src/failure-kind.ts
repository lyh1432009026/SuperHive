import { z } from "zod";

/**
 * 失败原因（Bridge 按运行时给的结构化字段和原文分好类后上报）。和 invocation-decision.ts 的 failureClass
 * （失败后能不能安全重放）是两件事：原因决定 Bridge 等不等、等多久、提示人做什么，故障单也按它分开归档。
 * 定义与判断规则在 superhive 的 failure.ts，两边的取值由 superhive 的 failure.test.ts 核对一致。
 */
export const failureKindSchema = z.enum([
  "network",
  "rate_limited",
  "overloaded",
  "provider_error",
  "quota",
  "billing",
  "auth",
  "model_unavailable",
  "context_overflow",
  "refused",
  "invalid_request",
  "session_invalid",
  "unknown",
]);
export type FailureKind = z.infer<typeof failureKindSchema>;
