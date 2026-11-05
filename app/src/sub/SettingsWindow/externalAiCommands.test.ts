import { describe, expect, it } from "vitest";
import { buildExternalAiMcpCommands, shellQuote } from "./externalAiCommands";

describe("buildExternalAiMcpCommands", () => {
  const launch = {
    node: "/opt/homebrew/bin/node",
    script: "/Volumes/soleilMacOS/codes/ai4Know/research-whiteboard/packages/project-graph-cli/src/cli.mjs",
    appHome: "/Volumes/soleilMacOS/codes/ai4Know/过程文件/app-home",
  };

  it("builds commands that paste into a shell as-is, with the app's HOME", () => {
    const commands = buildExternalAiMcpCommands(launch)!;
    const line = `/opt/homebrew/bin/node ${launch.script} mcp --app-home '${launch.appHome}'`;
    expect(commands.claudeCode).toBe(`claude mcp add --scope user research-workbench -- ${line}`);
    expect(commands.codex).toBe(`codex mcp add research-workbench -- ${line}`);
    expect(JSON.parse(commands.json)).toEqual({
      mcpServers: {
        "research-workbench": {
          command: "/opt/homebrew/bin/node",
          args: [launch.script, "mcp", "--app-home", launch.appHome],
        },
      },
    });
  });

  it("falls back to node on PATH and leaves out --app-home when unknown", () => {
    const commands = buildExternalAiMcpCommands({ ...launch, node: null, appHome: null })!;
    expect(commands.codex).toBe(`codex mcp add research-workbench -- node ${launch.script} mcp`);
  });

  it("has nothing to offer when the build carries no command-line entry", () => {
    expect(buildExternalAiMcpCommands({ ...launch, script: null })).toBeNull();
  });
});

describe("shellQuote", () => {
  it("quotes spaces, non-ASCII and single quotes only when needed", () => {
    expect(shellQuote("/usr/bin/node")).toBe("/usr/bin/node");
    expect(shellQuote("/Users/me/My Files")).toBe("'/Users/me/My Files'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});
