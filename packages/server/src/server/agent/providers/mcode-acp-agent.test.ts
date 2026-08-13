import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { ACPCatalogModelResolverContext } from "./acp-agent.js";
import {
  parseMCodeModels,
  resolveMCodeCatalogModels,
  writeMCodeProviderModel,
} from "./mcode-acp-agent.js";

describe("MiniMax Code model discovery", () => {
  test("parses provider-qualified models and the selected model", () => {
    expect(
      parseMCodeModels(
        [
          "Available models:",
          "- minimax/MiniMax-M3 (MiniMax-M3) [selected]",
          "- minimax/MiniMax-M2.7-highspeed (MiniMax-M2.7-highspeed)",
          "- custom_provider:volcengine/ark-code-latest (ark-code-latest)",
        ].join("\n"),
        "acp",
      ),
    ).toEqual([
      {
        provider: "acp",
        id: "minimax/MiniMax-M3",
        label: "MiniMax-M3",
        isDefault: true,
      },
      {
        provider: "acp",
        id: "minimax/MiniMax-M2.7-highspeed",
        label: "MiniMax-M2.7-highspeed",
        isDefault: false,
      },
      {
        provider: "acp",
        id: "custom_provider:volcengine/ark-code-latest",
        label: "ark-code-latest",
        isDefault: false,
      },
    ]);
  });

  test("falls back to the first model when MiniMax omits its selected marker", () => {
    expect(
      parseMCodeModels(
        ["- minimax/MiniMax-M3 (MiniMax-M3)", "- minimax/MiniMax-M2.7 (MiniMax-M2.7)"].join("\n"),
        "acp",
      ).map((model) => ({ id: model.id, isDefault: model.isDefault })),
    ).toEqual([
      { id: "minimax/MiniMax-M3", isDefault: true },
      { id: "minimax/MiniMax-M2.7", isDefault: false },
    ]);
  });

  test("uses the ACP prompt stream when session/new does not expose models", async () => {
    const sessionUpdates: ACPCatalogModelResolverContext["sessionUpdates"] = [];
    const context = {
      connection: {} as ACPCatalogModelResolverContext["connection"],
      sessionId: "session-1",
      models: [],
      configOptions: [],
      sessionUpdates,
      prompt: async () => {
        sessionUpdates.push({
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "- minimax/MiniMax-M3 (MiniMax-M3) [selected]\n",
            },
          },
        });
        return { stopReason: "end_turn" };
      },
      runRequest: async <T>(request: () => Promise<T>) => request(),
      transformConfigOptions: (configOptions: never[]) => configOptions,
      logger: createTestLogger(),
      provider: "acp",
    } satisfies ACPCatalogModelResolverContext;

    await expect(resolveMCodeCatalogModels(context)).resolves.toEqual([
      {
        provider: "acp",
        id: "minimax/MiniMax-M3",
        label: "MiniMax-M3",
        isDefault: true,
      },
    ]);
  });

  test("switches models through MiniMax Code's slash command", async () => {
    const prompt = vi.fn(async () => ({ stopReason: "end_turn" as const }));

    await writeMCodeProviderModel({
      connection: { prompt } as ACPCatalogModelResolverContext["connection"],
      sessionId: "session-1",
      requestedModelId: "minimax/MiniMax-M2.7-highspeed",
      currentModelId: "minimax/MiniMax-M3",
      selection: {
        availableModel: null,
        configOption: null,
        configChoice: null,
        hasAvailableModels: true,
      },
      configOptions: [],
      logger: createTestLogger(),
    });

    expect(prompt).toHaveBeenCalledWith({
      sessionId: "session-1",
      prompt: [{ type: "text", text: "/model minimax/MiniMax-M2.7-highspeed" }],
    });
  });
});
