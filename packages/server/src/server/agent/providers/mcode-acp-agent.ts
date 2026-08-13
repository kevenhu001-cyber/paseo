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

// MiniMax Code is an ACP-compatible coding agent shipped as the `mcode` CLI.
// Its default invocation is the ACP subcommand; the binary exposes slash
// commands asynchronously after session/new, like trae-cli and cursor-agent,
// so we wait for the first batch before resolving listCommands().
const MCODE_INITIAL_COMMANDS_WAIT_TIMEOUT_MS = 10_000;

export class MCodeACPAgentClient extends GenericACPAgentClient {
  constructor(options: MCodeACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      // mcode publishes slash commands and skills asynchronously via available_commands_update.
      waitForInitialCommands: true,
      initialCommandsWaitTimeoutMs: MCODE_INITIAL_COMMANDS_WAIT_TIMEOUT_MS,
    });
  }
}