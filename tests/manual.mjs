import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const tok = process.env.TOK;
const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js', '--url', 'http://192.168.51.152:8600', '--token', tok],
});
const client = new Client({ name: 'claude-sim', version: '1' }, { capabilities: {} });
await client.connect(transport);

const r1 = await client.callTool({ name: 'list_boards', arguments: {} });
const boards = JSON.parse(r1.content[0].text);
console.log('BOARDS:', boards.length, boards.slice(0,4).map(b=>b.name));

const prod = boards.find(b => b.name === 'Эпики продукта') || boards[0];
const r2 = await client.callTool({ name: 'create_card', arguments: { title: 'Карточка от MCP-Клода', boardId: prod.id, priority: true } });
console.log('CREATED:', r2.content[0].text);

const r3 = await client.callTool({ name: 'list_cards', arguments: { boardId: prod.id, limit: 5 } });
console.log('TOP 5 CARDS:', JSON.parse(r3.content[0].text).slice(0,3).map(c=>c.title));

await client.close();
