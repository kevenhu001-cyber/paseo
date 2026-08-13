import type { Logger } from "pino";

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
    });
  }
}
