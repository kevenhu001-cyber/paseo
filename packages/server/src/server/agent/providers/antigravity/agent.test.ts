import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Logger } from "pino";
import pino from "pino";
import { describe, expect, it } from "vitest";

import type { AgentSession, AgentStreamEvent } from "../../agent-sdk-types.js";
import { AntigravityAgentClient, mapAgyToolDetail, resolveAntigravityCommand } from "./agent.js";
import type { AntigravityProcessLaunch } from "./process.js";
import { parseAgyEvent, parseAgyModelsOutput } from "./stream-protocol.js";

function createLogger(): Logger {
  return pino({ level: "silent" });
}

class FakeAgyChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killed: string[] = [];
  readonly writtenLines: string[] = [];
  pid = 4242;

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.writtenLines.push(chunk.toString("utf8"));
    });
  }

  kill(signal?: string): boolean {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }

  emitLine(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  finish(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.emit("close", code, signal);
  }

  asChildProcess(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

interface SpawnedProcess {
  launch: AntigravityProcessLaunch;
  child: FakeAgyChild;
}

function createSpawnHarness() {
  const spawned: SpawnedProcess[] = [];
  const spawnFn = (launch: AntigravityProcessLaunch) => {
    const child = new FakeAgyChild();
    spawned.push({ launch, child });
    return child.asChildProcess();
  };
  return { spawned, spawnFn };
}

function lastChild(harness: ReturnType<typeof createSpawnHarness>): FakeAgyChild {
  const entry = harness.spawned.at(-1);
  if (!entry) {
    throw new Error("Expected a spawned agy process");
  }
  return entry.child;
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting: ${message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function collectEvents(target: AgentSession) {
  const events: AgentStreamEvent[] = [];
  const unsubscribe = target.subscribe((event) => {
    events.push(event);
  });
  return { events, unsubscribe };
}

async function closeSession(session: AgentSession, child: FakeAgyChild): Promise<void> {
  const closing = session.close();
  child.finish(0);
  await closing;
}

function initEvent(conversationId: string) {
  return {
    event: "init",
    conversation_id: conversationId,
    init: { cwd: "/workspace", tools: ["run_command"], permission_mode: "request-review" },
  };
}

describe("antigravity stream protocol", () => {
  it("parses agy models output rows and skips decoration lines", () => {
    const entries = parseAgyModelsOutput(
      "gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)\n\nclaude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)\n",
    );
    expect(entries).toEqual([
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
    ]);
  });

  it("parses init, step_update, and result events", () => {
    expect(parseAgyEvent(initEvent("conv-1"))).toMatchObject({
      kind: "init",
      conversationId: "conv-1",
    });
    expect(
      parseAgyEvent({
        event: "step_update",
        step_update: {
          step_index: 3,
          state: "DONE",
          step_type: "agent_response",
          text_delta: "hi",
        },
      }),
    ).toMatchObject({ kind: "step_update", stepType: "agent_response", textDelta: "hi" });
    expect(
      parseAgyEvent({
        event: "result",
        result: { status: "SUCCESS", response: "done" },
      }),
    ).toMatchObject({ kind: "result", status: "SUCCESS", response: "done" });
    expect(parseAgyEvent({ event: "something_new" })).toEqual({ kind: "unknown" });
  });

  it("maps run_command steps onto shell details and keeps unknown tools generic", () => {
    expect(
      mapAgyToolDetail({
        toolName: "run_command",
        parameters: { CommandLine: "echo hi" },
        output: "hi\n",
      }),
    ).toEqual({ type: "shell", command: "echo hi", output: "hi\n" });
    expect(
      mapAgyToolDetail({ toolName: "mystery_tool", parameters: { a: 1 }, output: "out" }),
    ).toEqual({
      type: "unknown",
      input: { tool: "mystery_tool", parameters: { a: 1 } },
      output: "out",
    });
  });

  it("maps file tools onto read/write/edit details", () => {
    expect(
      mapAgyToolDetail({
        toolName: "view_file",
        parameters: { AbsolutePath: "/tmp/probe.txt" },
        output: "2 lines, 7 bytes",
      }),
    ).toEqual({ type: "read", filePath: "/tmp/probe.txt", content: "2 lines, 7 bytes" });
    expect(
      mapAgyToolDetail({
        toolName: "write_to_file",
        parameters: { TargetFile: "/tmp/probe.txt" },
      }),
    ).toEqual({ type: "write", filePath: "/tmp/probe.txt" });
    expect(
      mapAgyToolDetail({
        toolName: "replace_file_content",
        parameters: { TargetFile: "/tmp/probe.txt" },
        output: "edited",
      }),
    ).toMatchObject({ type: "edit", filePath: "/tmp/probe.txt" });
    expect(
      mapAgyToolDetail({
        toolName: "multi_replace_file_content",
        parameters: { TargetFile: "/tmp/probe.txt" },
      }),
    ).toMatchObject({ type: "edit", filePath: "/tmp/probe.txt" });
  });

  it("maps listing and search tools onto search details", () => {
    expect(
      mapAgyToolDetail({
        toolName: "list_dir",
        parameters: { DirectoryPath: "/home/ubuntu" },
        output: "a\n",
      }),
    ).toEqual({ type: "search", query: "/home/ubuntu", toolName: "search", content: "a\n" });
    expect(
      mapAgyToolDetail({
        toolName: "find_by_name",
        parameters: { Pattern: "probe.txt", SearchDirectory: "/tmp" },
        output: "probe.txt",
      }),
    ).toEqual({ type: "search", query: "probe.txt", toolName: "glob", content: "probe.txt" });
    expect(
      mapAgyToolDetail({
        toolName: "grep_search",
        parameters: { Query: "paseo", SearchPath: "/home/ubuntu" },
        output: "hit",
      }),
    ).toEqual({ type: "search", query: "paseo", toolName: "grep", content: "hit" });
    expect(mapAgyToolDetail({ toolName: "search_web", parameters: { query: "agy CLI" } })).toEqual({
      type: "search",
      query: "agy CLI",
      toolName: "web_search",
    });
  });

  it("maps url, subagent, and prompt tools onto fetch/sub_agent/plain_text details", () => {
    expect(
      mapAgyToolDetail({
        toolName: "read_url_content",
        parameters: { Url: "https://example.com" },
        output: "body",
      }),
    ).toEqual({ type: "fetch", url: "https://example.com", result: "body" });
    expect(
      mapAgyToolDetail({
        toolName: "invoke_subagent",
        parameters: { agent: "researcher", task: "dig" },
        output: "done",
      }),
    ).toEqual({
      type: "sub_agent",
      subAgentType: "researcher",
      description: "dig",
      log: "done",
    });
    expect(mapAgyToolDetail({ toolName: "ask_question", parameters: { question: "go?" } })).toEqual(
      { type: "plain_text", label: "ask_question", icon: "sparkles", text: "go?" },
    );
    expect(mapAgyToolDetail({ toolName: "schedule", output: "later" })).toEqual({
      type: "plain_text",
      label: "schedule",
      icon: "brain",
      text: "later",
    });
    expect(
      mapAgyToolDetail({
        toolName: "capture_browser_screenshot",
        parameters: { Url: "https://example.com" },
      }),
    ).toEqual({
      type: "plain_text",
      label: "capture_browser_screenshot",
      icon: "eye",
      text: "https://example.com",
    });
  });

  it("resolves the default and overridden launch commands", () => {
    expect(resolveAntigravityCommand(undefined)).toEqual(["agy"]);
    expect(
      resolveAntigravityCommand({ command: { mode: "replace", argv: ["/opt/agy", "--flag"] } }),
    ).toEqual(["/opt/agy", "--flag"]);
  });
});

describe("AntigravityAgentClient sessions", () => {
  it("creates a session once the init event arrives and stamps persistence", async () => {
    const harness = createSpawnHarness();
    const client = new AntigravityAgentClient({ logger: createLogger(), spawnFn: harness.spawnFn });
    const created = client.createSession({ provider: "antigravity", cwd: "/workspace" });
    await waitFor(() => harness.spawned.length === 1, "agy process spawn");
    lastChild(harness).emitLine(initEvent("conv-1"));
    const session = await created;
    expect(session.id).toBe("conv-1");
    expect(harness.spawned[0]?.launch.args).toEqual([
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "24h",
    ]);
    expect(session.describePersistence()).toMatchObject({
      provider: "antigravity",
      sessionId: "conv-1",
      nativeHandle: "conv-1",
    });
    await closeSession(session, lastChild(harness));
  });

  it("passes model, effort, and full-access flags to the agy launch", async () => {
    const harness = createSpawnHarness();
    const client = new AntigravityAgentClient({ logger: createLogger(), spawnFn: harness.spawnFn });
    const created = client.createSession({
      provider: "antigravity",
      cwd: "/workspace",
      model: "gemini-3.8-flash-medium",
      thinkingOptionId: "high",
      modeId: "full-access",
    });
    await waitFor(() => harness.spawned.length === 1, "agy process spawn");
    const args = harness.spawned[0]?.launch.args ?? [];
    expect(args).toContain("--model");
    expect(args).toContain("gemini-3.8-flash-medium");
    expect(args).toContain("--effort");
    expect(args).toContain("high");
    expect(args).toContain("--dangerously-skip-permissions");
    lastChild(harness).emitLine(initEvent("conv-2"));
    const session = await created;
    await closeSession(session, lastChild(harness));
  });

  it("streams a turn to completion with text, tool, and usage events", async () => {
    const harness = createSpawnHarness();
    const client = new AntigravityAgentClient({ logger: createLogger(), spawnFn: harness.spawnFn });
    const created = client.createSession({ provider: "antigravity", cwd: "/workspace" });
    await waitFor(() => harness.spawned.length === 1, "agy process spawn");
    const child = lastChild(harness);
    child.emitLine(initEvent("conv-3"));
    const session = await created;
    const { events } = collectEvents(session);

    const runPromise = session.run("Summarize the repo");
    await waitFor(() => child.writtenLines.length === 1, "prompt written to stdin");
    expect(child.writtenLines[0]).toContain("Summarize the repo");

    child.emitLine({
      event: "step_update",
      step_update: {
        step_index: 2,
        state: "ACTIVE",
        step_type: "agent_response",
        text_delta: "Hello ",
      },
    });
    child.emitLine({
      event: "step_update",
      step_update: {
        step_index: 2,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "world",
      },
    });
    child.emitLine({
      event: "step_update",
      step_update: {
        step_index: 3,
        state: "DONE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { name: "run_command", parameters: { CommandLine: "ls" }, output: "a\n" },
      },
    });
    child.emitLine({
      event: "result",
      result: {
        conversation_id: "conv-3",
        status: "SUCCESS",
        response: "Hello world",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, total_tokens: 15 },
      },
    });

    const result = await runPromise;
    expect(result.finalText).toBe("Hello world");
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 });
    const timelineItems = events
      .filter((event) => event.type === "timeline")
      .map((event) => (event.type === "timeline" ? event.item.type : null));
    expect(timelineItems).toContain("assistant_message");
    expect(timelineItems).toContain("tool_call");
    expect(events.some((event) => event.type === "turn_completed")).toBe(true);
    await closeSession(session, child);
  });

  it("fails session creation when agy exits before init", async () => {
    const harness = createSpawnHarness();
    const client = new AntigravityAgentClient({ logger: createLogger(), spawnFn: harness.spawnFn });
    const created = client.createSession({ provider: "antigravity", cwd: "/workspace" });
    await waitFor(() => harness.spawned.length === 1, "agy process spawn");
    const child = lastChild(harness);
    child.stderr.write("authentication required: run agy interactively\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    child.finish(1);
    await expect(created).rejects.toThrow("authentication required");
  });

  it("interrupts a running turn with SIGINT and reports cancellation", async () => {
    const harness = createSpawnHarness();
    const client = new AntigravityAgentClient({ logger: createLogger(), spawnFn: harness.spawnFn });
    const created = client.createSession({ provider: "antigravity", cwd: "/workspace" });
    await waitFor(() => harness.spawned.length === 1, "agy process spawn");
    const child = lastChild(harness);
    child.emitLine(initEvent("conv-4"));
    const session = await created;
    const { events } = collectEvents(session);

    const runPromise = session.run("Long task");
    await waitFor(() => child.writtenLines.length === 1, "prompt written to stdin");
    const interruptPromise = session.interrupt();
    await waitFor(() => child.killed.includes("SIGINT"), "SIGINT sent to agy");
    child.emitLine({
      event: "result",
      result: { conversation_id: "conv-4", status: "INTERRUPTED", response: "" },
    });
    await interruptPromise;
    await runPromise;
    expect(events.some((event) => event.type === "turn_canceled")).toBe(true);
    await closeSession(session, child);
  });

  it("resumes a conversation by its native handle", async () => {
    const harness = createSpawnHarness();
    const client = new AntigravityAgentClient({ logger: createLogger(), spawnFn: harness.spawnFn });
    const resumed = client.resumeSession(
      {
        provider: "antigravity",
        sessionId: "conv-9",
        nativeHandle: "conv-9",
        metadata: { cwd: "/workspace", model: "gemini-3.8-flash-medium" },
      },
      { cwd: "/workspace" },
    );
    await waitFor(() => harness.spawned.length === 1, "agy process spawn");
    const args = harness.spawned[0]?.launch.args ?? [];
    expect(args).toContain("--conversation");
    expect(args).toContain("conv-9");
    lastChild(harness).emitLine(initEvent("conv-9"));
    const session = await resumed;
    expect(session.id).toBe("conv-9");
    const info = await session.getRuntimeInfo();
    expect(info.model).toBe("gemini-3.8-flash-medium");
    await closeSession(session, lastChild(harness));
  });

  it("rejects resume without a native handle", async () => {
    const harness = createSpawnHarness();
    const client = new AntigravityAgentClient({ logger: createLogger(), spawnFn: harness.spawnFn });
    await expect(
      client.resumeSession({ provider: "antigravity", sessionId: "conv-9" }),
    ).rejects.toThrow("native conversation handle");
    expect(harness.spawned.length).toBe(0);
  });

  it("restarts the process to apply a mode change against the same conversation", async () => {
    const harness = createSpawnHarness();
    const client = new AntigravityAgentClient({ logger: createLogger(), spawnFn: harness.spawnFn });
    const created = client.createSession({ provider: "antigravity", cwd: "/workspace" });
    await waitFor(() => harness.spawned.length === 1, "agy process spawn");
    lastChild(harness).emitLine(initEvent("conv-5"));
    const session = await created;
    const firstChild = lastChild(harness);

    const modeChanged = session.setMode("full-access");
    await waitFor(() => harness.spawned.length === 2, "agy process respawn");
    const args = harness.spawned[1]?.launch.args ?? [];
    expect(args).toContain("--conversation");
    expect(args).toContain("conv-5");
    expect(args).toContain("--dangerously-skip-permissions");
    lastChild(harness).emitLine(initEvent("conv-5"));
    await waitFor(() => firstChild.stdin.writableEnded === true, "old process stdin closed");
    firstChild.finish(0);
    await modeChanged;
    expect(await session.getCurrentMode()).toBe("full-access");
    await closeSession(session, lastChild(harness));
  });
});
