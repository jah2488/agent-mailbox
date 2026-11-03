// stdio entry point for Claude Code: `claude mcp add ... -- node src/mcp-main.ts`.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { depsFromEnv } from "./config.ts";
import { createMailboxServer } from "./mcp-server.ts";

await createMailboxServer(depsFromEnv()).connect(new StdioServerTransport());
