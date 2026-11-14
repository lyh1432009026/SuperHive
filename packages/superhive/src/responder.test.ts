import { describe, expect, it } from "vitest";
import { isModelUnavailable, isSessionInvalid, isUpstreamFailure } from "./responder.js";

describe("isSessionInvalid", () => {
  it("recognizes the ways runtimes report a session that cannot continue", () => {
    for (const text of [
      '{"error":{"code":"invalid_encrypted_content","message":"The encrypted content for item rs_1 could not be verified."}}',
      "Encrypted content could not be decrypted or parsed.",
      "previous_response_not_found",
      "Previous response with id 'resp_1' not found.",
      "No conversation found with session ID: 0b1c",
      "no rollout found for thread id thread-old",
      "Session not found: ses-old",
      "failed to load rollout: unexpected end of file",
      "corrupted session file",
    ]) {
      expect(isSessionInvalid(text), text).toBe(true);
    }
  });

  it("does not mistake ordinary failures for a broken session", () => {
    for (const text of [
      "rate limit exceeded: token rate limit",
      "sandbox denied the patch",
      "API Error: 529 overloaded",
      "insufficient_quota",
      "file not found: src/a.ts",
    ]) {
      expect(isSessionInvalid(text), text).toBe(false);
    }
  });
});

describe("isModelUnavailable", () => {
  it("recognizes a model that is missing or retired", () => {
    for (const text of [
      '{"error":{"code":"model_not_found","message":"The model gpt-old does not exist"}}',
      "The model `gpt-old` does not exist or you do not have access to it.",
      'not_found_error: {"type":"not_found_error","message":"model: claude-old"}',
      "model gpt-4 has been deprecated",
      "Unknown model: foo/bar",
    ]) {
      expect(isModelUnavailable(text), text).toBe(true);
    }
  });

  it("never treats quota or auth problems as a reason to switch models", () => {
    for (const text of [
      "insufficient_quota: You exceeded your current quota for model gpt-main",
      "401 Unauthorized: model gpt-main",
      "invalid api key for model gpt-main",
      "billing hard limit reached; model unavailable",
    ]) {
      expect(isModelUnavailable(text), text).toBe(false);
      expect(isUpstreamFailure(text), text).toBe(false);
    }
  });
});
