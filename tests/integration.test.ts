// Integration test: запускаем MCP server как child process через stdio,
// используя MCP client SDK, и гоняем через tools end-to-end против live backend.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const BASE = process.env.MAITO_URL ?? 'http://192.168.51.152:8600';
// Тест создаёт себе уникального юзера, чтобы не зависеть от заранее созданных.
const EMAIL = `mcp-qa-${Date.now()}@maito.test`;
const PASSWORD = 'mcptest-secret-1';

async function getToken(): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`signup failed: ${r.status}`);
  const b = (await r.json()) as { token: string };
  return b.token;
}

let client: Client;
let token: string;

async function seedMinimalFixture(tok: string) {
  // После signup state пустой — seed-ом занимается фронт, но для MCP тестов
  // мы не грузим фронт. Создаём минимум сами: workspace + space + board + column.
  const nowTs = Date.now();
  const seed = {
    workspaces: [{
      id: '__workspace_default__', name: 'Test', icon: '◆', color: '#6366f1', order: 0,
      createdAt: nowTs, inboxSpaceId: '__inbox__', inboxBoardId: '__inbox_board__', inboxColumnId: '__inbox_column__',
    }],
    spaces: [{ id: 's1', workspaceId: '__workspace_default__', name: 'Test space', icon: '⬢', color: '#22c55e', order: 0, createdAt: nowTs, archived: false }],
    boards: [{
      id: 'b1', spaceId: 's1', parentBoardId: null, name: 'Test board', order: 0, createdAt: nowTs,
      displayMode: 'all', layout: 'board', archived: false, subtasksTargetColumnId: null,
    }],
    columns: [{ id: 'c1', boardId: 'b1', name: 'Backlog', order: 0 }],
    cards: [],
    comments: [],
    tags: [],
    notes: [{ id: 'n1', workspaceId: '__workspace_default__', title: 'фичатогл заметка', body: 'Test', tags: [], pinned: false, folderId: null, attachments: [], createdAt: nowTs, updatedAt: nowTs }],
    noteFolders: [],
    activity: [],
  };
  const r = await fetch(`${BASE}/api/state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ data: seed }),
  });
  if (!r.ok) throw new Error(`seed PUT failed: ${r.status}`);
}

before(async () => {
  token = await getToken();
  await seedMinimalFixture(token);
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js', '--url', BASE, '--token', token],
  });
  client = new Client({ name: 'maito-test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
});

after(async () => {
  await client.close();
});

describe('MCP server integration', () => {
  it('lists tools', async () => {
    const res = await client.listTools();
    const names = res.tools.map((t) => t.name).sort();
    for (const expected of [
      'list_spaces',
      'list_boards',
      'list_cards',
      'create_card',
      'update_card',
      'archive_card',
      'add_journal_entry',
      'search_notes',
      'get_note',
      'create_note',
      'today_plan',
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
  });

  it('list_spaces возвращает список', async () => {
    const r = await client.callTool({ name: 'list_spaces', arguments: {} });
    assert.equal(r.isError, undefined);
    const content = (r.content as any[])?.[0]?.text;
    const arr = JSON.parse(content);
    assert.ok(Array.isArray(arr));
  });

  it('create_card + update_card + archive_card round-trip', async () => {
    // найти первую доску
    const boardsRes = await client.callTool({ name: 'list_boards', arguments: {} });
    const boards = JSON.parse((boardsRes.content as any[])[0].text);
    assert.ok(boards.length > 0, 'no boards — fixture broken');
    const firstBoard = boards[0];

    // create_card без columnId — должен найти первую колонку
    const create = await client.callTool({
      name: 'create_card',
      arguments: { title: 'MCP test ' + Date.now(), boardId: firstBoard.id, priority: true },
    });
    assert.equal(create.isError, undefined);
    const { id } = JSON.parse((create.content as any[])[0].text);
    assert.ok(id);

    // update_card
    const upd = await client.callTool({
      name: 'update_card',
      arguments: { id, patch: { title: 'MCP updated' } },
    });
    assert.equal(upd.isError, undefined);

    // archive_card
    const arch = await client.callTool({ name: 'archive_card', arguments: { id } });
    assert.equal(arch.isError, undefined);

    // убедимся что карточка пропала из активного list_cards
    const activeRes = await client.callTool({ name: 'list_cards', arguments: {} });
    const active = JSON.parse((activeRes.content as any[])[0].text);
    assert.ok(!active.find((c: any) => c.id === id), 'archived card still in active list');

    // и появилась в archived
    const archivedRes = await client.callTool({
      name: 'list_cards',
      arguments: { archived: true },
    });
    const archived = JSON.parse((archivedRes.content as any[])[0].text);
    assert.ok(archived.find((c: any) => c.id === id), 'archived card not in archived list');
  });

  it('search_notes и get_note', async () => {
    const searchRes = await client.callTool({
      name: 'search_notes',
      arguments: { query: 'фичатогл', limit: 5 },
    });
    const hits = JSON.parse((searchRes.content as any[])[0].text);
    assert.ok(Array.isArray(hits));
    if (hits.length > 0) {
      const getRes = await client.callTool({
        name: 'get_note',
        arguments: { id: hits[0].id },
      });
      const note = JSON.parse((getRes.content as any[])[0].text);
      assert.equal(note.id, hits[0].id);
      assert.ok(typeof note.body === 'string');
    }
  });

  it('today_plan без ошибок', async () => {
    const r = await client.callTool({ name: 'today_plan', arguments: {} });
    assert.equal(r.isError, undefined);
    const plan = JSON.parse((r.content as any[])[0].text);
    assert.ok(typeof plan.count === 'number');
    assert.ok(Array.isArray(plan.cards));
  });
});
