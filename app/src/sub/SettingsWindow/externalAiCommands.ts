/** Rust 端 external_ai_mcp_launch 返回的东西 */
export type ExternalAiMcpLaunch = {
  node: string | null;
  /** 命令行入口；安装包版本还没有，为空 */
  script: string | null;
  /** 程序用的 HOME；开发版改过，MCP 要跟它用同一个 */
  appHome: string | null;
};

export type ExternalAiMcpCommands = {
  claudeCode: string;
  codex: string;
  /** Claude Desktop、Cursor 等用的 JSON 配置 */
  json: string;
};

export const EXTERNAL_AI_MCP_NAME = "research-workbench";

/** 只在需要时加单引号，让命令能原样粘进 zsh / bash */
export function shellQuote(argument: string): string {
  return /^[\w@%+=:,./-]+$/.test(argument) ? argument : `'${argument.replace(/'/g, `'\\''`)}'`;
}

export function buildExternalAiMcpCommands(launch: ExternalAiMcpLaunch): ExternalAiMcpCommands | null {
  if (!launch.script) return null;
  const command = launch.node ?? "node";
  const args = [launch.script, "mcp", ...(launch.appHome ? ["--app-home", launch.appHome] : [])];
  const line = [command, ...args].map(shellQuote).join(" ");
  return {
    // user：在任何文件夹里打开 Claude Code 都能用
    claudeCode: `claude mcp add --scope user ${EXTERNAL_AI_MCP_NAME} -- ${line}`,
    codex: `codex mcp add ${EXTERNAL_AI_MCP_NAME} -- ${line}`,
    json: JSON.stringify({ mcpServers: { [EXTERNAL_AI_MCP_NAME]: { command, args } } }, null, 2),
  };
}
