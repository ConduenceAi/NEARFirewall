export interface AgentPlatform {
  id: string;
  name: string;
  type: string;
  initials: string;
  aliases?: string;
  setup?: string;
}

export const platforms: AgentPlatform[] = [
  { id: "claude-desktop", name: "Claude Desktop", type: "Chat assistants", initials: "CL", aliases: "anthropic local mcp", setup: "Merge the mcpServers entry into claude_desktop_config.json, then fully quit and reopen the app." },
  { id: "chatgpt", name: "ChatGPT", type: "Chat assistants", initials: "CG", aliases: "openai remote mcp" },
  { id: "n8n", name: "n8n", type: "Workflow automation", initials: "n8", aliases: "remote mcp http" },
  { id: "claude-code", name: "Claude Code", type: "Coding agents", initials: "CC", aliases: "anthropic local mcp", setup: "Merge the mcpServers entry into your local user MCP configuration and check the connection with /mcp." },
  { id: "cursor", name: "Cursor", type: "Coding agents", initials: "CU", aliases: "local mcp", setup: "Merge the mcpServers entry into your user-level ~/.cursor/mcp.json and reload the editor." },
  { id: "claude-web", name: "Claude on the web", type: "Chat assistants", initials: "CW", aliases: "anthropic claude.ai remote mcp" },
  { id: "copilot-studio", name: "Microsoft Copilot Studio", type: "Chat assistants", initials: "CS" },
  { id: "vscode", name: "VS Code", type: "Coding agents", initials: "VS", aliases: "copilot" },
  { id: "windsurf", name: "Windsurf", type: "Coding agents", initials: "WS" },
  { id: "zapier", name: "Zapier", type: "Workflow automation", initials: "ZA" },
  { id: "make", name: "Make", type: "Workflow automation", initials: "MK" },
  { id: "langgraph", name: "LangChain / LangGraph", type: "Agent frameworks", initials: "LG" },
  { id: "near-ai", name: "NEAR AI agents", type: "Web3 agent kits", initials: "NA" },
  { id: "custom", name: "Custom local MCP client", type: "Custom", initials: "<>", aliases: "sdk stdio", setup: "Configure your client to launch the local MCP server over stdio with this command, argument and environment." },
];

export function searchPlatforms(query: string): AgentPlatform[] {
  const words = query.toLowerCase().trim().split(/\s+/);
  return platforms.filter((p) => words.every((word) => `${p.name} ${p.type} ${p.aliases ?? ""}`.toLowerCase().includes(word)));
}
