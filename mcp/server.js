#!/usr/bin/env node
// Judge Protocol's MCP server over stdio (see README.md). From a checkout: cd mcp && npm ci && node server.js
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createJudgeServer } from "./src/judge-mcp.js";

await createJudgeServer().connect(new StdioServerTransport());
