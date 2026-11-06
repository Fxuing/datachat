#!/usr/bin/env node
// Minimal stdio MCP server used by the admin connection-test tests.
// Usage: node fake-mcp-server.mjs [ok|hang|leak]
//   ok   - answers initialize + tools/list with three tools
//   hang - answers initialize but never answers tools/list (timeout path)
//   leak - fails tools/list with a message containing $FAKE_MCP_SECRET (sanitization path)
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const mode = process.argv[2] ?? "ok";

const server = new Server(
  { name: "fake-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (mode === "hang") {
    // Never settle: the client must hit its own timeout instead of an error response.
    return new Promise(() => {});
  }
  if (mode === "leak") {
    throw new Error(`upstream exploded with ${process.env.FAKE_MCP_SECRET ?? "no-secret"}`);
  }
  return {
    tools: [
      {
        name: "echo",
        description: "Echo the given text",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
      },
      {
        name: "add",
        description: "Add two numbers",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
      },
      {
        name: "now",
        description: "",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  };
});

await server.connect(new StdioServerTransport());
