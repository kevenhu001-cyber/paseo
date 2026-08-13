import type { Logger } from "pino";

import type { AgentModelDefinition } from "../agent-sdk-types.js";
import {
  type ACPCatalogModelResolverContext,
  type ACPProviderModelWriterContext,
} from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

interface MCodeACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

const MCODE_INITIAL_COMMANDS_WAIT_TIMEOUT_MS = 10_000;

export function parseMCodeModels(text: string, provider: string): AgentModelDefinition[] {
  const models: AgentModelDefinition[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^\s*-\s+(.+?)\s+\(([^()]+)\)(?:\s+\[selected\])?\s*$/u);
    const fallback = line.match(/^\s*-\s+(\S+)(?:\s+\[selected\])?\s*$/u);
    const modelId = match?.[1]?.trim() ?? fallback?.[1]?.trim();
    if (!modelId || seen.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    const label = match?.[2]?.trim() || modelId;
    models.push({
      provider,
      id: modelId,
      label,
      isDefault: /\[selected\]\s*$/u.test(line),
    });
  }
  if (models.length > 0 && !models.some((model) => model.isDefault)) {
    models[0] = { ...models[0], isDefault: true };
  }
  return models;
}

function getMCodePromptOutput(context: ACPCatalogModelResolverContext, start: number): string {
  const chunks: string[] = [];
  for (const notification of context.sessionUpdates.slice(start)) {
    if (notification.sessionId !== context.sessionId) {
      continue;
    }
    const update = notification.update;
    if (update.sessionUpdate !== "agent_message_chunk") {
      continue;
    }
    if (update.content.type === "text") {
      chunks.push(update.content.text);
    }
  }
  return chunks.join("");
}

export async function resolveMCodeCatalogModels(
  context: ACPCatalogModelResolverContext,
): Promise<AgentModelDefinition[]> {
  const start = context.sessionUpdates.length;
  try {
    await context.prompt("/model");
  } catch (error) {
    context.logger.warn({ error }, "MiniMax Code model discovery command failed");
    return context.models;
  }

  const models = parseMCodeModels(getMCodePromptOutput(context, start), context.provider);
  return models.length > 0 ? models : context.models;
}

export async function writeMCodeProviderModel(
  context: ACPProviderModelWriterContext,
): Promise<{ handled: true; currentModelId: string }> {
  await context.connection.prompt({
    sessionId: context.sessionId,
    prompt: [{ type: "text", text: `/model ${context.requestedModelId}` }],
  });
  return { handled: true, currentModelId: context.requestedModelId };
}

/**
 * MiniMax Code publishes slash commands asynchronously after session/new.
 * Wait for the first update so the catalog and composer do not observe an
 * empty command list during startup.
 */
export class MCodeACPAgentClient extends GenericACPAgentClient {
  constructor(options: MCodeACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      waitForInitialCommands: true,
      initialCommandsWaitTimeoutMs: MCODE_INITIAL_COMMANDS_WAIT_TIMEOUT_MS,
      catalogModelResolver: resolveMCodeCatalogModels,
      providerModelWriter: writeMCodeProviderModel,
    });
  }
}
