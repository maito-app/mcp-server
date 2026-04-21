#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MaitoClient } from './client.js';
import { buildTools, INSTRUCTIONS, type Tools } from './tools.js';

function parseArgs(argv: string[]): { url: string; token: string } {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      args[key] = val;
    }
  }
  const url = args.url ?? process.env.MAITO_URL ?? '';
  const token = args.token ?? process.env.MAITO_TOKEN ?? '';
  if (!url) throw new Error('Missing --url or MAITO_URL');
  if (!token) throw new Error('Missing --token or MAITO_TOKEN');
  return { url, token };
}

async function main() {
  const { url, token } = parseArgs(process.argv.slice(2));
  const client = new MaitoClient(url, token);

  // quick ping; don't crash on 401 because token might be expired — let caller see
  try {
    await client.health();
  } catch (e) {
    console.error('[maito-mcp] warning: health check failed:', (e as Error).message);
  }

  const tools = buildTools({ url, token });

  const server = new Server(
    { name: 'maito', version: '0.1.4' },
    {
      capabilities: { tools: {} },
      instructions: INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(tools).map(([name, t]) => ({
      name,
      description: (t as any).description,
      inputSchema: (t as any).inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name as keyof Tools;
    const handler = tools[name];
    if (!handler) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    try {
      return await (handler as any).handler(req.params.arguments ?? {}, client);
    } catch (e: any) {
      return {
        content: [{ type: 'text', text: `Tool error: ${e?.message ?? e}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[maito-mcp] connected via stdio, baseUrl=' + url);
}

main().catch((e) => {
  console.error('[maito-mcp] fatal:', e);
  process.exit(1);
});
