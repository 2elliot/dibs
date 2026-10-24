import { afterEach, expect, it, vi } from "vitest";
import { AnthropicModelClient } from "../src/model/anthropic.ts";
import { buildAnalysisRequest } from "../src/analysis/prompt.ts";
import { loadFixture } from "./helpers.ts";

afterEach(() => vi.unstubAllGlobals());

it("streams schema-constrained findings through the real SDK", async () => {
  const input = loadFixture("compatible");
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "tool_test",
        name: "report_findings",
        input: {},
      },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(input.recordedFindings),
      },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  ];
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      events
        .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
        .join(""),
      {
        headers: { "content-type": "text/event-stream" },
      },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const model = new AnthropicModelClient({
    apiKey: "test-placeholder",
    model: "claude-sonnet-4-6",
  });
  const output = await model.analyze(buildAnalysisRequest(input), {
    timeoutMs: 1000,
  });
  expect(output.findings).toEqual(input.recordedFindings);
  expect(output.usage).toEqual({ inputTokens: 3, outputTokens: 5 });
  const request = JSON.parse(fetch.mock.calls[0][1].body);
  expect(request.stream).toBe(true);
  expect(request.tools[0].strict).toBe(true);
});

it("does not let SDK retries bypass the worker's retry budget", async () => {
  const fetch = vi.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "overloaded_error", message: "test overload" },
        }),
        {
          status: 529,
          headers: { "content-type": "application/json" },
        },
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const model = new AnthropicModelClient({
    apiKey: "test-placeholder",
    model: "claude-sonnet-4-6",
  });
  await expect(
    model.analyze(buildAnalysisRequest(loadFixture("compatible")), {
      timeoutMs: 1000,
    }),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
});
