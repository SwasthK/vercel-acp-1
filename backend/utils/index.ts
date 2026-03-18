import type { McpServerInput, SessionConfig } from "../types";

export function normalizeMcpServers(
  input: McpServerInput[] | undefined
): SessionConfig["mcpServers"] {
  if (!input || input.length === 0) return [];

  return input.map((s) => {
    if (s.type === "stdio") {
      return {
        name: s.name,
        command: s.command,
        args: s.args ?? [],
        env: Object.entries(s.env ?? {}).map(([name, value]) => ({
          name,
          value,
        })),
      };
    }

    return {
      type: s.type,
      name: s.name,
      url: s.url,
      headers: Object.entries(s.headers ?? {}).map(([name, value]) => ({
        name,
        value,
      })),
    };
  });
}