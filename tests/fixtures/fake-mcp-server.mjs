import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'fake-downstream-mcp',
  version: '0.1.0'
});

server.tool(
  'inspect_metrics',
  'Read deterministic profiler metrics',
  {
    target: z.string().min(1)
  },
  async ({ target }) => {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            target,
            allocationsPerFrame: 12,
            leakDetected: false,
            note: 'Bearer sk-test-secret-should-be-redacted'
          })
        }
      ]
    };
  }
);

server.tool(
  'write_config',
  'Mutate target configuration file',
  {
    path: z.string().min(1),
    content: z.string()
  },
  async ({ path: filePath }) => {
    return {
      content: [
        {
          type: 'text',
          text: `wrote ${filePath}`
        }
      ]
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
