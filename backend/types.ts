import {
  ACPProvider,
  createACPProvider,
  type ACPProviderSettings,
} from "@mcpc-tech/acp-ai-provider";

type SessionAgentConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  authMethodId?: string;
};

type SessionConfig = {
  cwd: string;
  mcpServers: ACPProviderSettings["session"]["mcpServers"];
};

type McpServerInput =
  | {
    type: "stdio";
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }
  | {
    type: "http" | "sse";
    name: string;
    url: string;
    headers?: Record<string, string>;
  };

type SessionEntry = {
  id: string;
  provider: ACPProvider;
  createdAt: number;
  updatedAt: number;
  agent: SessionAgentConfig;
  sessionConfig: SessionConfig;
  acpSessionId?: string;
  availableModels?: string[];
  availableModes?: string[];
  currentModel?: string;
  currentMode?: string;
};

type CreateSessionBody = {
  agentCommand: string;
  args?: string[];
  env?: Record<string, string>;
  authMethodId?: string;
  cwd?: string;
  mcpServers?: McpServerInput[];
};

type SetModelBody = {
  modelId?: string;
  modeId?: string;
};

type ChatStreamBody = {
  prompt: string;
};

export type { SessionAgentConfig, SessionConfig, McpServerInput, SessionEntry, CreateSessionBody, SetModelBody, ChatStreamBody };