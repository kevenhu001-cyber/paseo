import { z } from "zod";

/**
 * Wire protocol for `agy --input-format stream-json --output-format stream-json`.
 *
 * Shapes follow the official headless-mode documentation
 * (https://antigravity.google/docs/cli/headless/). Objects use `.passthrough()`
 * so future `agy` fields do not break parsing; unknown `step_type` values are
 * carried as strings and ignored by the session mapper.
 */

const AgyUsageSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    thinking_tokens: z.number().optional(),
    cache_read_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  })
  .passthrough();

export type AgyUsage = z.infer<typeof AgyUsageSchema>;

const AgyInitPayloadSchema = z
  .object({
    cwd: z.string().optional(),
    tools: z.array(z.string()).optional(),
    permission_mode: z.string().optional(),
    model: z.string().optional(),
    agent: z.string().optional(),
  })
  .passthrough();

const AgyInitEventSchema = z
  .object({
    event: z.literal("init"),
    conversation_id: z.string().min(1),
    init: AgyInitPayloadSchema.optional(),
  })
  .passthrough();

const AgyToolInfoSchema = z
  .object({
    name: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    output: z.string().optional(),
    error: z
      .object({
        type: z.string().optional(),
        message: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const AgySubagentInfoSchema = z
  .object({
    subagents: z
      .array(
        z
          .object({
            type_name: z.string().optional(),
            role: z.string().optional(),
            conversation_id: z.string().optional(),
            log_uri: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const AgyStepUpdateSchema = z
  .object({
    conversation_id: z.string().optional(),
    step_index: z.number().optional(),
    state: z.string().optional(),
    step_type: z.string().optional(),
    tool_name: z.string().optional(),
    text_delta: z.string().optional(),
    duration_seconds: z.number().optional(),
    usage: AgyUsageSchema.optional(),
    tool_info: AgyToolInfoSchema.optional(),
    subagent_info: AgySubagentInfoSchema.optional(),
  })
  .passthrough();

const AgyStepUpdateEventSchema = z
  .object({
    event: z.literal("step_update"),
    step_update: AgyStepUpdateSchema,
  })
  .passthrough();

const AgyResultPayloadSchema = z
  .object({
    conversation_id: z.string().optional(),
    status: z.string().optional(),
    response: z.string().optional(),
    error: z.string().optional(),
    duration_seconds: z.number().optional(),
    num_turns: z.number().optional(),
    usage: AgyUsageSchema.optional(),
  })
  .passthrough();

const AgyResultEventSchema = z
  .object({
    event: z.literal("result"),
    result: AgyResultPayloadSchema,
  })
  .passthrough();

export interface AgyInitEvent {
  kind: "init";
  conversationId: string;
  model?: string;
  permissionMode?: string;
}

export interface AgyStepUpdate {
  kind: "step_update";
  stepIndex?: number;
  state?: string;
  stepType?: string;
  toolName?: string;
  textDelta?: string;
  usage?: AgyUsage;
  toolInfo?: z.infer<typeof AgyToolInfoSchema>;
  subagentInfo?: z.infer<typeof AgySubagentInfoSchema>;
}

export interface AgyResult {
  kind: "result";
  conversationId?: string;
  status?: string;
  response: string;
  error?: string;
  usage?: AgyUsage;
}

export interface AgyUnknownEvent {
  kind: "unknown";
}

export type AgyEvent = AgyInitEvent | AgyStepUpdate | AgyResult | AgyUnknownEvent;

/** Terminal `result.status` values that end a turn without an error. */
const AGY_SUCCESS_STATUS = "SUCCESS";
/** Statuses that mean the turn was stopped rather than failed. */
const AGY_CANCELED_STATUSES = new Set(["CANCELED", "INTERRUPTED"]);

export function isAgyTurnSuccess(status: string | undefined): boolean {
  return status === AGY_SUCCESS_STATUS;
}

export function isAgyTurnCanceled(status: string | undefined): boolean {
  return status !== undefined && AGY_CANCELED_STATUSES.has(status);
}

export function parseAgyEvent(value: unknown): AgyEvent {
  const initParsed = AgyInitEventSchema.safeParse(value);
  if (initParsed.success) {
    return {
      kind: "init",
      conversationId: initParsed.data.conversation_id,
      model: initParsed.data.init?.model,
      permissionMode: initParsed.data.init?.permission_mode,
    };
  }
  const stepParsed = AgyStepUpdateEventSchema.safeParse(value);
  if (stepParsed.success) {
    const step = stepParsed.data.step_update;
    return {
      kind: "step_update",
      stepIndex: step.step_index,
      state: step.state,
      stepType: step.step_type,
      toolName: step.tool_name,
      textDelta: step.text_delta,
      usage: step.usage,
      toolInfo: step.tool_info,
      subagentInfo: step.subagent_info,
    };
  }
  const resultParsed = AgyResultEventSchema.safeParse(value);
  if (resultParsed.success) {
    const result = resultParsed.data.result;
    return {
      kind: "result",
      conversationId: result.conversation_id,
      status: result.status,
      response: result.response ?? "",
      error: result.error,
      usage: result.usage,
    };
  }
  return { kind: "unknown" };
}

export interface AgyModelEntry {
  id: string;
  label: string;
}

/**
 * Parse `agy models` stdout (`<slug><whitespace><label>` per line).
 * Lines that do not match are skipped so future output decorations
 * (headers, hints) do not break discovery.
 */
export function parseAgyModelsOutput(stdout: string): AgyModelEntry[] {
  const entries: AgyModelEntry[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^(\S+)\s+(.+)$/.exec(line.trimEnd());
    if (!match?.[1] || !match[2]) {
      continue;
    }
    const label = match[2].trim();
    if (!label) {
      continue;
    }
    entries.push({ id: match[1], label });
  }
  return entries;
}

/** Reasoning effort levels accepted by `agy --effort`. */
export const AGY_EFFORT_OPTIONS: ReadonlyArray<{
  id: string;
  label: string;
  description: string;
}> = [
  { id: "low", label: "Low", description: "Faster reasoning" },
  { id: "medium", label: "Medium", description: "Balanced reasoning" },
  { id: "high", label: "High", description: "Deeper reasoning" },
];
