import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { promisify } from "node:util";
import { z } from "zod";

import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentFeature,
  AgentLaunchContext,
  AgentMode,
  AgentPersistenceHandle,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPromptInput,
  AgentProvider,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentSlashCommand,
  AgentStreamEvent,
  AgentUsage,
  FetchCatalogOptions,
  ImportableProviderSession,
  ListImportableSessionsOptions,
  ProviderCatalog,
  ProviderRefreshContext,
  ToolCallDetail,
} from "../../agent-sdk-types.js";
import { renderPromptAttachmentAsText } from "../../../prompt-attachments.js";
import { runProviderRefreshActivity } from "../../../provider-refresh-deadline.js";
import {
  checkProviderLaunchAvailable,
  createProviderEnv,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
  type ResolvedProviderLaunch,
} from "../../../provider-launch-config.js";
import { composeSystemPromptParts } from "../../../system-prompt.js";
import {
  buildBinaryDiagnosticRows,
  buildCommandResolutionDiagnosticRows,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  toDiagnosticErrorMessage,
} from "../../diagnostic-utils.js";
import { materializeProviderImage } from "../../provider-image-output.js";
import { appendOrReplaceGrowingAssistantMessage, runProviderTurn } from "../../provider-runner.js";
import {
  AGY_EFFORT_OPTIONS,
  isAgyTurnCanceled,
  isAgyTurnSuccess,
  parseAgyEvent,
  parseAgyModelsOutput,
  type AgyUsage as AgyWireUsage,
} from "./stream-protocol.js";
import {
  AntigravityProcess,
  type AntigravityProcessExit,
  type AntigravitySpawnFn,
} from "./process.js";

const ANTIGRAVITY_PROVIDER = "antigravity";

function defaultAgyBinary(): string {
  return process.env.AGY_COMMAND ?? "agy";
}

const ANTIGRAVITY_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
};

export const ANTIGRAVITY_DEFAULT_MODE_ID = "default";
export const ANTIGRAVITY_FULL_ACCESS_MODE_ID = "full-access";

const ANTIGRAVITY_MODES: AgentMode[] = [
  {
    id: ANTIGRAVITY_DEFAULT_MODE_ID,
    label: "Default",
    description: "Follows your agy permission policy; tools outside the policy are skipped",
  },
  {
    id: ANTIGRAVITY_FULL_ACCESS_MODE_ID,
    label: "Full Access",
    description: "Passes --dangerously-skip-permissions; tools run without prompts",
  },
];

/**
 * agy headless runs impose a per-turn ceiling (default 5m). Paseo owns turn
 * lifetime and interruption itself, so launch streaming sessions with a ceiling
 * far beyond any realistic turn instead of letting agy cut turns short.
 */
const AGY_PRINT_TIMEOUT = "24h";
const STARTUP_TIMEOUT_MS = 60_000;
const INTERRUPT_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 5_000;
const MAX_HISTORY_ENTRIES = 500;

/**
 * Provider params are intentionally small: model, effort, and mode travel on
 * the session config, so only process-level timeouts live here.
 */
const AntigravityProviderParamsSchema = z
  .object({
    startupTimeoutMs: z.number().int().positive().optional(),
    printTimeout: z.string().min(1).optional(),
  })
  .passthrough();

type AntigravityProviderParams = z.infer<typeof AntigravityProviderParamsSchema>;

interface AntigravitySessionLaunch {
  cwd: string;
  model?: string;
  effort?: string;
  modeId: string;
  conversationId?: string;
  env?: Record<string, string>;
  printTimeout: string;
}

function resolveModeId(modeId: string | undefined): string {
  const resolved = modeId ?? ANTIGRAVITY_DEFAULT_MODE_ID;
  if (!ANTIGRAVITY_MODES.some((mode) => mode.id === resolved)) {
    throw new Error(`Unknown Antigravity mode: ${modeId}`);
  }
  return resolved;
}

function buildAntigravityArgs(session: AntigravitySessionLaunch): string[] {
  const args = ["--input-format", "stream-json", "--output-format", "stream-json"];
  args.push("--print-timeout", session.printTimeout);
  if (session.model) {
    args.push("--model", session.model);
  }
  if (session.effort) {
    args.push("--effort", session.effort);
  }
  if (session.modeId === ANTIGRAVITY_FULL_ACCESS_MODE_ID) {
    args.push("--dangerously-skip-permissions");
  }
  if (session.conversationId) {
    args.push("--conversation", session.conversationId);
  }
  return args;
}

export function resolveAntigravityCommand(
  runtimeSettings: ProviderRuntimeSettings | undefined,
): [string, ...string[]] {
  if (
    runtimeSettings?.command?.mode === "replace" &&
    runtimeSettings.command.argv.length > 0 &&
    runtimeSettings.command.argv[0]
  ) {
    return runtimeSettings.command.argv as [string, ...string[]];
  }
  return [defaultAgyBinary()];
}

function mapAgyUsage(usage: AgyWireUsage | undefined): AgentUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const mapped: AgentUsage = {};
  if (typeof usage.input_tokens === "number") {
    mapped.inputTokens = usage.input_tokens;
  }
  if (typeof usage.cache_read_tokens === "number") {
    mapped.cachedInputTokens = usage.cache_read_tokens;
  }
  if (typeof usage.output_tokens === "number") {
    mapped.outputTokens = usage.output_tokens;
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function coerceStringRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function formatToolParameters(parameters: Record<string, unknown> | undefined): string {
  if (!parameters) {
    return "";
  }
  try {
    return JSON.stringify(parameters);
  } catch {
    return "[unserializable parameters]";
  }
}

/**
 * Map one agy `tool` step onto a normalized tool-call detail. `run_command`
 * has a stable documented shape; every other tool keeps its raw parameters
 * and output behind the generic `unknown` detail until its shape is observed.
 */
export function mapAgyToolDetail(input: {
  toolName?: string;
  parameters?: Record<string, unknown>;
  output?: string;
}): ToolCallDetail {
  const toolName = input.toolName ?? "unknown";
  if (toolName === "run_command") {
    const parameters = input.parameters ?? {};
    return {
      type: "shell",
      command:
        firstString(parameters, ["CommandLine", "command"]) ?? formatToolParameters(parameters),
      ...(input.output !== undefined ? { output: input.output } : {}),
    };
  }
  const filePath = input.parameters
    ? firstString(input.parameters, ["path", "filePath", "file", "filename"])
    : null;
  if (filePath && /read/i.test(toolName)) {
    return {
      type: "read",
      filePath,
      ...(input.output !== undefined ? { content: input.output } : {}),
    };
  }
  if (filePath && /edit/i.test(toolName)) {
    return {
      type: "edit",
      filePath,
      ...(input.output !== undefined ? { unifiedDiff: input.output } : {}),
    };
  }
  if (filePath && /write/i.test(toolName)) {
    return {
      type: "write",
      filePath,
      ...(input.output !== undefined ? { content: input.output } : {}),
    };
  }
  return {
    type: "unknown",
    input: {
      tool: toolName,
      ...(input.parameters ? { parameters: input.parameters } : {}),
    },
    output: input.output ?? null,
  };
}

interface StartTurnResult {
  turnId: string;
}

interface ActiveTurn {
  turnId: string;
  userText: string;
  assistantText: string;
  done: Promise<void>;
  markDone: () => void;
}

interface HistoryEntry {
  role: "user" | "assistant" | "error";
  text: string;
}

interface AntigravityAgentSessionOptions {
  provider: AgentProvider;
  logger: Logger;
  process: AntigravityProcess;
  conversationId: string;
  cwd: string;
  model?: string;
  effort?: string;
  modeId: string;
  systemPrompt?: string;
  spawn: (launch: AntigravitySessionLaunch) => Promise<{
    process: AntigravityProcess;
    conversationId: string;
  }>;
}

export class AntigravityAgentSession implements AgentSession {
  readonly provider: AgentProvider;
  readonly capabilities: AgentCapabilityFlags = ANTIGRAVITY_CAPABILITIES;

  private readonly logger: Logger;
  private process: AntigravityProcess;
  private conversationId: string;
  private readonly cwd: string;
  private model: string | undefined;
  private effort: string | undefined;
  private modeId: string;
  private readonly systemPrompt: string | undefined;
  private readonly spawn: AntigravityAgentSessionOptions["spawn"];
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private activeTurn: ActiveTurn | null = null;
  private readonly history: HistoryEntry[] = [];
  private turnCount = 0;
  private closed = false;
  private disposing = false;
  private interruptRequestedFor: string | null = null;

  constructor(options: AntigravityAgentSessionOptions) {
    this.provider = options.provider;
    this.logger = options.logger;
    this.process = options.process;
    this.conversationId = options.conversationId;
    this.cwd = options.cwd;
    this.model = options.model;
    this.effort = options.effort;
    this.modeId = options.modeId;
    this.systemPrompt = options.systemPrompt;
    this.spawn = options.spawn;
    this.attachTo(options.process);
  }

  get id(): string | null {
    return this.conversationId;
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    return runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: (p, o) => this.startTurn(p, o),
      subscribe: (callback) => this.subscribe(callback),
      getSessionId: () => this.conversationId,
      reduceFinalText: appendOrReplaceGrowingAssistantMessage,
    });
  }

  async startTurn(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<StartTurnResult> {
    if (this.closed) {
      throw new Error("Antigravity session is closed");
    }
    if (this.activeTurn) {
      throw new Error("An Antigravity turn is already active");
    }
    const text = this.buildPromptText(prompt);
    const turnId = randomUUID();
    let markDone!: () => void;
    const done = new Promise<void>((resolve) => {
      markDone = resolve;
    });
    this.activeTurn = { turnId, userText: text, assistantText: "", done, markDone };
    this.turnCount += 1;
    this.emit({ type: "turn_started", provider: this.provider, turnId });
    if (options?.clientMessageId) {
      this.logger.debug(
        { turnId, clientMessageId: options.clientMessageId },
        "Antigravity turn started",
      );
    }
    void this.sendPrompt(turnId, text);
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    for (const entry of this.history) {
      if (entry.role === "user") {
        yield {
          type: "timeline",
          provider: this.provider,
          item: { type: "user_message", text: entry.text },
        };
      } else if (entry.role === "assistant") {
        yield {
          type: "timeline",
          provider: this.provider,
          item: { type: "assistant_message", text: entry.text },
        };
      } else {
        yield {
          type: "timeline",
          provider: this.provider,
          item: { type: "error", message: entry.text },
        };
      }
    }
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return {
      provider: this.provider,
      sessionId: this.conversationId,
      model: this.model ?? null,
      thinkingOptionId: this.effort ?? null,
      modeId: this.modeId,
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [...ANTIGRAVITY_MODES];
  }

  async getCurrentMode(): Promise<string | null> {
    return this.modeId;
  }

  async setMode(modeId: string): Promise<void> {
    if (!ANTIGRAVITY_MODES.some((mode) => mode.id === modeId)) {
      throw new Error(`Unknown Antigravity mode: ${modeId}`);
    }
    if (modeId === this.modeId) {
      return;
    }
    await this.restartProcess({ modeId });
  }

  async setModel(modelId: string | null): Promise<void> {
    const next = modelId ?? undefined;
    if (next === this.model) {
      return;
    }
    await this.restartProcess({ model: next });
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    const next = thinkingOptionId ?? undefined;
    if (next === this.effort) {
      return;
    }
    await this.restartProcess({ effort: next });
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }

  async respondToPermission(requestId: string, _response: AgentPermissionResponse): Promise<void> {
    throw new Error(`Unknown Antigravity permission request: ${requestId}`);
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    // agy answers slash commands itself in headless streaming sessions with an
    // error result, so none are offered.
    return [];
  }

  describePersistence(): AgentPersistenceHandle | null {
    return {
      provider: this.provider,
      sessionId: this.conversationId,
      nativeHandle: this.conversationId,
      metadata: {
        cwd: this.cwd,
        ...(this.model ? { model: this.model } : {}),
        ...(this.effort ? { thinkingOptionId: this.effort } : {}),
        ...(this.modeId ? { modeId: this.modeId } : {}),
      },
    };
  }

  async interrupt(): Promise<void> {
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }
    this.interruptRequestedFor = turn.turnId;
    try {
      this.process.interrupt();
      const settled = await this.waitForTurnDone(turn, INTERRUPT_TIMEOUT_MS);
      if (!settled) {
        this.logger.debug(
          { turnId: turn.turnId },
          "Antigravity turn ignored SIGINT; killing process",
        );
        this.process.kill();
        await turn.done;
      }
    } finally {
      if (this.interruptRequestedFor === turn.turnId) {
        this.interruptRequestedFor = null;
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.disposing = true;
    try {
      if (this.activeTurn) {
        this.process.interrupt();
      }
      this.process.closeStdin();
      const exited = await this.waitForExit(this.process, CLOSE_TIMEOUT_MS);
      if (!exited) {
        this.process.kill();
        await this.process.waitForExit();
      }
    } finally {
      this.disposing = false;
    }
  }

  private buildPromptText(prompt: AgentPromptInput): string {
    const blocks = typeof prompt === "string" ? [{ type: "text" as const, text: prompt }] : prompt;
    const textParts: string[] = [];
    for (const block of blocks) {
      if (block.type === "text") {
        textParts.push(block.text);
        continue;
      }
      if (block.type === "image") {
        textParts.push(renderImageHint(block));
        continue;
      }
      textParts.push(renderPromptAttachmentAsText(block));
    }
    let text = textParts.join("\n\n");
    // agy headless sessions accept no system-prompt flag, so fold Paseo's
    // system instructions into the first user turn instead of dropping them.
    if (this.turnCount === 0 && this.systemPrompt) {
      text = `${this.systemPrompt}\n\n---\n\n${text}`;
    }
    return text;
  }

  private async sendPrompt(turnId: string, text: string): Promise<void> {
    try {
      await this.process.writeLine({ event: "user", message: { content: text } });
    } catch (error) {
      this.failTurn(turnId, toDiagnosticErrorMessage(error));
    }
  }

  private attachTo(proc: AntigravityProcess): void {
    proc.onLine((value) => {
      this.handleEvent(parseAgyEvent(value));
    });
    proc.onExit((exit) => {
      this.handleExit(exit, proc);
    });
  }

  private handleEvent(event: ReturnType<typeof parseAgyEvent>): void {
    if (event.kind === "init" || event.kind === "unknown") {
      return;
    }
    if (event.kind === "result") {
      this.handleResult(event);
      return;
    }
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }
    if (event.stepType === "agent_response" && event.textDelta) {
      turn.assistantText += event.textDelta;
      this.emit({
        type: "timeline",
        provider: this.provider,
        turnId: turn.turnId,
        item: { type: "assistant_message", text: event.textDelta },
      });
      return;
    }
    if (event.stepType === "tool" && event.state === "DONE") {
      this.emitToolStep(turn.turnId, event);
      return;
    }
    if (event.usage) {
      const usage = mapAgyUsage(event.usage);
      if (usage) {
        this.emit({ type: "usage_updated", provider: this.provider, usage, turnId: turn.turnId });
      }
    }
  }

  private emitToolStep(
    turnId: string,
    event: Extract<ReturnType<typeof parseAgyEvent>, { kind: "step_update" }>,
  ): void {
    if (event.subagentInfo?.subagents?.length) {
      this.emitSubagentStep(turnId, event);
      return;
    }
    const toolInfo = event.toolInfo;
    const detail = mapAgyToolDetail({
      toolName: toolInfo?.name ?? event.toolName,
      parameters: coerceStringRecord(toolInfo?.parameters) ?? undefined,
      output: toolInfo?.output,
    });
    const toolError = toolInfo?.error?.message ?? toolInfo?.error?.type;
    const callId = `agy-${event.stepIndex ?? 0}`;
    const name = toolInfo?.name ?? event.toolName ?? "unknown";
    if (toolError) {
      this.emit({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: {
          type: "tool_call",
          callId,
          name,
          status: "failed",
          error: toolError,
          detail,
        },
      });
      return;
    }
    this.emit({
      type: "timeline",
      provider: this.provider,
      turnId,
      item: {
        type: "tool_call",
        callId,
        name,
        status: "completed",
        error: null,
        detail,
      },
    });
  }

  private emitSubagentStep(
    turnId: string,
    event: Extract<ReturnType<typeof parseAgyEvent>, { kind: "step_update" }>,
  ): void {
    const subagents = event.subagentInfo?.subagents ?? [];
    const log = subagents
      .map((subagent) => {
        const name = subagent.role ?? subagent.type_name ?? "subagent";
        const id = subagent.conversation_id ?? subagent.log_uri ?? "";
        return id ? `${name}: ${id}` : name;
      })
      .join("\n");
    this.emit({
      type: "timeline",
      provider: this.provider,
      turnId,
      item: {
        type: "tool_call",
        callId: `agy-${event.stepIndex ?? 0}`,
        name: event.toolName ?? "subagent",
        status: "completed",
        error: null,
        detail: { type: "sub_agent", log },
      },
    });
  }

  private handleResult(event: Extract<ReturnType<typeof parseAgyEvent>, { kind: "result" }>): void {
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }
    const usage = mapAgyUsage(event.usage);
    if (usage) {
      this.emit({ type: "usage_updated", provider: this.provider, usage, turnId: turn.turnId });
    }
    if (isAgyTurnSuccess(event.status)) {
      this.pushHistory({ role: "user", text: turn.userText });
      if (turn.assistantText) {
        this.pushHistory({ role: "assistant", text: turn.assistantText });
      }
      this.activeTurn = null;
      turn.markDone();
      this.emit({
        type: "turn_completed",
        provider: this.provider,
        turnId: turn.turnId,
        ...(usage ? { usage } : {}),
      });
      return;
    }
    if (isAgyTurnCanceled(event.status)) {
      this.cancelTurn(turn.turnId, event.status ?? "canceled");
      return;
    }
    this.failTurn(
      turn.turnId,
      event.error || `agy turn ended with status ${event.status ?? "unknown"}`,
    );
  }

  private handleExit(exit: AntigravityProcessExit, proc: AntigravityProcess): void {
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }
    if (this.disposing || this.closed) {
      this.cancelTurn(turn.turnId, "session closed");
      return;
    }
    if (this.interruptRequestedFor === turn.turnId) {
      this.cancelTurn(turn.turnId, "interrupted");
      return;
    }
    const detail = proc.getStderrTail().trim();
    const reason =
      detail.length > 0
        ? `agy exited before the turn completed: ${detail.slice(-2000)}`
        : `agy exited before the turn completed (code ${exit.code ?? "unknown"})`;
    this.failTurn(turn.turnId, reason);
  }

  private failTurn(turnId: string, error: string): void {
    const turn = this.activeTurn;
    if (!turn || turn.turnId !== turnId) {
      return;
    }
    this.pushHistory({ role: "user", text: turn.userText });
    this.pushHistory({ role: "error", text: error });
    this.activeTurn = null;
    turn.markDone();
    this.emit({ type: "turn_failed", provider: this.provider, turnId, error });
  }

  private cancelTurn(turnId: string, reason: string): void {
    const turn = this.activeTurn;
    if (!turn || turn.turnId !== turnId) {
      return;
    }
    this.activeTurn = null;
    turn.markDone();
    this.emit({ type: "turn_canceled", provider: this.provider, turnId, reason });
  }

  private pushHistory(entry: HistoryEntry): void {
    this.history.push(entry);
    while (this.history.length > MAX_HISTORY_ENTRIES) {
      this.history.shift();
    }
  }

  private async waitForTurnDone(turn: ActiveTurn, timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        turn.done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
    return this.activeTurn?.turnId !== turn.turnId;
  }

  private async waitForExit(target: AntigravityProcess, timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        target.waitForExit(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
    return target.exited;
  }

  /**
   * Model, effort, and permission mode are agy launch flags, so changing them
   * spawns the replacement streaming process first and only then retires the
   * old one: a failed respawn leaves the live session untouched.
   */
  private async restartProcess(overrides: {
    model?: string;
    effort?: string;
    modeId?: string;
  }): Promise<void> {
    if (this.closed) {
      throw new Error("Antigravity session is closed");
    }
    if (this.activeTurn) {
      throw new Error("Stop the running Antigravity turn before changing model, effort, or mode");
    }
    const previous = this.process;
    const spawned = await this.spawn({
      cwd: this.cwd,
      model: overrides.model !== undefined ? overrides.model : this.model,
      effort: overrides.effort !== undefined ? overrides.effort : this.effort,
      modeId: overrides.modeId !== undefined ? resolveModeId(overrides.modeId) : this.modeId,
      conversationId: this.conversationId,
      printTimeout: AGY_PRINT_TIMEOUT,
    });
    if (overrides.model !== undefined) {
      this.model = overrides.model;
    }
    if (overrides.effort !== undefined) {
      this.effort = overrides.effort;
    }
    if (overrides.modeId !== undefined) {
      this.modeId = overrides.modeId;
    }
    this.process = spawned.process;
    this.conversationId = spawned.conversationId;
    this.attachTo(spawned.process);
    previous.closeStdin();
    if (!(await this.waitForExit(previous, CLOSE_TIMEOUT_MS))) {
      previous.kill();
      await previous.waitForExit();
    }
  }

  private emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}

function renderImageHint(image: { data: string; mimeType: string }): string {
  // agy stream-json input accepts text blocks only, so images always travel
  // as local file path hints, mirroring the Pi text-only fallback.
  try {
    const materialized = materializeProviderImage({ data: image.data, mimeType: image.mimeType });
    return `[Image available at: ${materialized.path}]`;
  } catch (error) {
    return `[Image attachment omitted: failed to write local file (${toDiagnosticErrorMessage(error)})]`;
  }
}

export interface AntigravityAgentClientOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  providerParams?: unknown;
  spawnFn?: AntigravitySpawnFn;
}

export class AntigravityAgentClient implements AgentClient {
  readonly provider: AgentProvider = ANTIGRAVITY_PROVIDER;
  readonly capabilities: AgentCapabilityFlags = ANTIGRAVITY_CAPABILITIES;

  private readonly logger: Logger;
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly providerParams: AntigravityProviderParams;
  private readonly spawnFn?: AntigravitySpawnFn;

  constructor(options: AntigravityAgentClientOptions) {
    this.logger = options.logger;
    this.runtimeSettings = options.runtimeSettings;
    this.providerParams = AntigravityProviderParamsSchema.parse(options.providerParams ?? {});
    this.spawnFn = options.spawnFn;
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const modeId = resolveModeId(config.modeId);
    const spawned = await this.startRuntimeSession(
      {
        cwd: config.cwd,
        model: config.model,
        effort: config.thinkingOptionId,
        modeId,
        printTimeout: this.providerParams.printTimeout ?? AGY_PRINT_TIMEOUT,
      },
      launchContext?.env,
    );
    return new AntigravityAgentSession({
      provider: this.provider,
      logger: this.logger,
      process: spawned.process,
      conversationId: spawned.conversationId,
      cwd: config.cwd,
      model: config.model,
      effort: config.thinkingOptionId,
      modeId,
      systemPrompt: composeSystemPromptParts(config.systemPrompt, config.daemonAppendSystemPrompt),
      spawn: (launch) => this.startRuntimeSession(launch, launchContext?.env),
    });
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const conversationId = handle.nativeHandle;
    if (!conversationId) {
      throw new Error("Antigravity resume requires a native conversation handle");
    }
    const metadata = coerceStringRecord(handle.metadata) ?? {};
    const cwd = overrides?.cwd ?? (typeof metadata.cwd === "string" ? metadata.cwd : undefined);
    if (!cwd) {
      throw new Error("Antigravity resume requires a working directory");
    }
    const model =
      overrides?.model ?? (typeof metadata.model === "string" ? metadata.model : undefined);
    const effort =
      overrides?.thinkingOptionId ??
      (typeof metadata.thinkingOptionId === "string" ? metadata.thinkingOptionId : undefined);
    const modeId = resolveModeId(
      overrides?.modeId ?? (typeof metadata.modeId === "string" ? metadata.modeId : undefined),
    );
    const spawned = await this.startRuntimeSession(
      {
        cwd,
        model,
        effort,
        modeId,
        conversationId,
        printTimeout: this.providerParams.printTimeout ?? AGY_PRINT_TIMEOUT,
      },
      launchContext?.env,
    );
    return new AntigravityAgentSession({
      provider: this.provider,
      logger: this.logger,
      process: spawned.process,
      conversationId: spawned.conversationId,
      cwd,
      model,
      effort,
      modeId,
      systemPrompt: composeSystemPromptParts(
        overrides?.systemPrompt,
        overrides?.daemonAppendSystemPrompt,
      ),
      spawn: (launch) => this.startRuntimeSession(launch, launchContext?.env),
    });
  }

  async fetchCatalog(
    options: FetchCatalogOptions,
    context?: ProviderRefreshContext,
  ): Promise<ProviderCatalog> {
    const launch = await this.resolveLaunch();
    const cwd = options.scope === "workspace" ? options.cwd : homedir();
    const models = await runProviderRefreshActivity(context, "models", async () => {
      const output = await this.readModelsOutput(launch, cwd, context);
      return parseAgyModelsOutput(output).map((entry) => ({
        provider: this.provider,
        id: entry.id,
        label: entry.label,
        thinkingOptions: AGY_EFFORT_OPTIONS.map((option) => ({
          id: option.id,
          label: option.label,
          description: option.description,
        })),
      }));
    });
    return { models, modes: [...ANTIGRAVITY_MODES], defaultModeId: ANTIGRAVITY_DEFAULT_MODE_ID };
  }

  async listFeatures(_config: AgentSessionConfig): Promise<AgentFeature[]> {
    return [];
  }

  async listImportableSessions(
    _options?: ListImportableSessionsOptions,
  ): Promise<ImportableProviderSession[]> {
    return [];
  }

  async isAvailable(): Promise<boolean> {
    try {
      const launch = await this.resolveLaunch();
      const availability = await checkProviderLaunchAvailable(launch);
      return availability.available;
    } catch {
      return false;
    }
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const launch = await this.resolveLaunch();
      const availability = await checkProviderLaunchAvailable(launch);
      const settingsPath = join(homedir(), ".gemini", "antigravity-cli", "settings.json");
      return {
        diagnostic: formatProviderDiagnostic("Antigravity", [
          ...(await buildCommandResolutionDiagnosticRows(launch, {
            knownBinaryNames: [launch.command],
          })),
          ...(await buildBinaryDiagnosticRows(launch, availability)),
          {
            label: "CLI settings (~/.gemini/antigravity-cli/settings.json)",
            value: existsSync(settingsPath)
              ? "found (authenticate once with an interactive agy session)"
              : "not found (run agy interactively to authenticate)",
          },
        ]),
      };
    } catch (error) {
      return {
        diagnostic: formatProviderDiagnosticError("Antigravity", error),
      };
    }
  }

  private async startRuntimeSession(
    session: AntigravitySessionLaunch,
    envOverlay?: Record<string, string>,
  ): Promise<{ process: AntigravityProcess; conversationId: string }> {
    const command = resolveAntigravityCommand(this.runtimeSettings);
    const launch = {
      command: command[0],
      args: [...command.slice(1), ...buildAntigravityArgs(session)],
      cwd: session.cwd,
      env: createProviderEnv({ runtimeSettings: this.runtimeSettings, overlays: [envOverlay] }),
    };
    const process = AntigravityProcess.spawn({
      launch: {
        command: launch.command,
        args: launch.args,
        cwd: launch.cwd,
        env: launch.env as Record<string, string>,
      },
      logger: this.logger,
      ...(this.spawnFn ? { spawnFn: this.spawnFn } : {}),
    });
    const conversationId = await this.waitForInit(process);
    return { process, conversationId };
  }

  private async waitForInit(process: AntigravityProcess): Promise<string> {
    const timeoutMs = this.providerParams.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    return new Promise<string>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const fail = (error: Error) => {
        if (timer) {
          clearTimeout(timer);
        }
        process.kill();
        reject(error);
      };
      const unsubscribeLine = process.onLine((value) => {
        const event = parseAgyEvent(value);
        if (event.kind !== "init") {
          return;
        }
        if (timer) {
          clearTimeout(timer);
        }
        unsubscribeLine();
        unsubscribeExit();
        resolve(event.conversationId);
      });
      const unsubscribeExit = process.onExit(() => {
        const detail = process.getStderrTail().trim();
        unsubscribeLine();
        fail(
          new Error(
            detail.length > 0
              ? `agy exited during startup: ${detail.slice(-2000)}`
              : "agy exited during startup before sending its init event",
          ),
        );
      });
      timer = setTimeout(() => {
        unsubscribeLine();
        unsubscribeExit();
        fail(new Error(`agy did not send its init event within ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  private async resolveLaunch(): Promise<ResolvedProviderLaunch> {
    return resolveProviderLaunch({
      commandConfig: this.runtimeSettings?.command,
      defaultBinary: defaultAgyBinary(),
    });
  }

  private async readModelsOutput(
    launch: ResolvedProviderLaunch,
    cwd: string,
    context?: ProviderRefreshContext,
  ): Promise<string> {
    const run = promisify(execFile);
    const child = run(launch.command, [...launch.args, "models"], {
      cwd,
      env: createProviderEnv({ runtimeSettings: this.runtimeSettings }),
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      ...(context ? { signal: context.signal } : {}),
    });
    const { stdout } = await runProviderRefreshActivity(context, "models.exec", () => child);
    return stdout;
  }
}
