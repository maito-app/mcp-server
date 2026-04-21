import type { MaitoClient, Snapshot } from './client.js';

function now(): number {
  return Date.now();
}

function err(msg: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
}

function ok(obj: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }],
  };
}

function resolveWorkspaceId(data: Snapshot, argWs: unknown): string | null {
  const all = (data.workspaces ?? []).filter((w) => !w.archived);
  if (typeof argWs === 'string' && argWs) {
    const hit = all.find((w) => w.id === argWs);
    return hit?.id ?? null;
  }
  if (all.length === 1) return all[0].id;
  return null;
}

/** Maps boardId → workspaceId so we can tag cards with their workspace without extra lookups. */
function boardWsIndex(data: Snapshot): Map<string, string> {
  const spaceWs = new Map<string, string>();
  for (const s of data.spaces ?? []) spaceWs.set(s.id, s.workspaceId);
  const columnBoard = new Map<string, string>();
  for (const col of data.columns ?? []) columnBoard.set(col.id, col.boardId);
  const boardWs = new Map<string, string>();
  for (const b of data.boards ?? []) {
    const ws = spaceWs.get(b.spaceId);
    if (ws) boardWs.set(b.id, ws);
  }
  // attach column→ws so cards can be resolved via columnId
  for (const [colId, boardId] of columnBoard) {
    const ws = boardWs.get(boardId);
    if (ws) boardWs.set(colId, ws);
  }
  return boardWs;
}

export const tools = {
  list_workspaces: {
    description:
      'List all workspaces. Each workspace is an isolated container with its own spaces, boards, cards, and notes. Use this first to orient yourself before scoping other queries.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args: any, client: MaitoClient) => {
      const { data } = await client.getState();
      const wss = (data.workspaces ?? []).filter((w) => !w.archived);
      const spaceCount = new Map<string, number>();
      for (const s of data.spaces ?? []) {
        if (s.archived) continue;
        spaceCount.set(s.workspaceId, (spaceCount.get(s.workspaceId) ?? 0) + 1);
      }
      return ok(
        wss.map((w) => ({
          id: w.id,
          name: w.name,
          spaces: spaceCount.get(w.id) ?? 0,
        })),
      );
    },
  },

  list_spaces: {
    description:
      'List spaces. If workspaceId is omitted and there is only one workspace, uses it; otherwise returns spaces from ALL workspaces with workspaceId labelled.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Optional workspace id to scope to.' },
      },
    },
    handler: async (args: any, client: MaitoClient) => {
      const { data } = await client.getState();
      const wsFilter = resolveWorkspaceId(data, args?.workspaceId);
      const spaces = (data.spaces ?? []).filter((s) => {
        if (s.archived) return false;
        if (args?.workspaceId) return s.workspaceId === args.workspaceId;
        if (wsFilter) return s.workspaceId === wsFilter;
        return true;
      });
      return ok(
        spaces.map((s) => ({
          id: s.id,
          name: s.name,
          workspaceId: s.workspaceId,
          order: s.order,
        })),
      );
    },
  },

  list_boards: {
    description:
      'List boards. Filter by workspaceId and/or spaceId. Each returned board includes workspaceId + spaceId so callers can see scope.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Filter by workspace id.' },
        spaceId: { type: 'string', description: 'Filter by space id.' },
      },
    },
    handler: async (args: any, client: MaitoClient) => {
      const { data } = await client.getState();
      const spaceWs = new Map<string, string>();
      for (const s of data.spaces ?? []) spaceWs.set(s.id, s.workspaceId);
      let boards = (data.boards ?? []).filter((b) => !b.archived);
      if (args?.spaceId) boards = boards.filter((b) => b.spaceId === args.spaceId);
      if (args?.workspaceId)
        boards = boards.filter((b) => spaceWs.get(b.spaceId) === args.workspaceId);
      return ok(
        boards.map((b) => ({
          id: b.id,
          name: b.name,
          workspaceId: spaceWs.get(b.spaceId) ?? null,
          spaceId: b.spaceId,
          parentBoardId: b.parentBoardId,
          displayMode: b.displayMode,
          layout: b.layout,
        })),
      );
    },
  },

  list_cards: {
    description:
      'List cards. Filter by workspaceId, boardId, done, archived, priorityOnly. Each returned card includes workspaceId + boardId.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        boardId: { type: 'string' },
        done: { type: 'boolean' },
        archived: { type: 'boolean' },
        priorityOnly: { type: 'boolean' },
        limit: { type: 'number' },
      },
    },
    handler: async (args: any, client: MaitoClient) => {
      const { data } = await client.getState();
      const wsIdx = boardWsIndex(data);
      const colToBoard = new Map<string, string>();
      for (const col of data.columns ?? []) colToBoard.set(col.id, col.boardId);
      let cards = data.cards ?? [];
      if (args?.archived !== true) cards = cards.filter((c) => !c.archived);
      else cards = cards.filter((c) => c.archived);
      if (typeof args?.done === 'boolean') cards = cards.filter((c) => !!c.done === args.done);
      if (args?.priorityOnly) cards = cards.filter((c) => c.priority);
      if (args?.boardId) {
        const cols = (data.columns ?? []).filter((c) => c.boardId === args.boardId).map((c) => c.id);
        const set = new Set(cols);
        cards = cards.filter((c) => set.has(c.columnId));
      }
      if (args?.workspaceId) {
        cards = cards.filter((c) => wsIdx.get(c.columnId) === args.workspaceId);
      }
      const limit = typeof args?.limit === 'number' ? args.limit : 100;
      return ok(
        cards.slice(0, limit).map((c) => ({
          id: c.id,
          title: c.title,
          done: !!c.done,
          priority: !!c.priority,
          isEpic: !!c.isEpic,
          deadline: c.deadline,
          scheduledFor: c.scheduledFor,
          parentCardId: c.parentCardId,
          tagIds: c.tagIds,
          columnId: c.columnId,
          boardId: colToBoard.get(c.columnId) ?? null,
          workspaceId: wsIdx.get(c.columnId) ?? null,
        })),
      );
    },
  },

  create_card: {
    description:
      'Create a new task card. Specify columnId (most precise) OR boardId (uses first column). The card inherits its workspace from the column/board.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        columnId: { type: 'string' },
        boardId: { type: 'string' },
        priority: { type: 'boolean' },
        isEpic: { type: 'boolean' },
        deadline: { type: 'number', description: 'Epoch ms' },
        scheduledFor: { type: 'number', description: 'Epoch ms' },
        tagIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['title'],
    },
    handler: async (args: any, client: MaitoClient) => {
      if (!args?.title) return err('title is required');
      let createdId = '';
      await client.mutate((draft) => {
        let columnId: string | undefined = args.columnId;
        if (!columnId && args.boardId) {
          const col = (draft.columns ?? [])
            .filter((c) => c.boardId === args.boardId)
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
          columnId = col?.id;
        }
        if (!columnId) throw new Error('columnId or boardId required');
        const maxOrder = Math.max(
          -1,
          ...(draft.cards ?? []).filter((c) => c.columnId === columnId).map((c) => c.order ?? 0),
        );
        const id = client.newId();
        createdId = id;
        const nowTs = now();
        (draft.cards ??= []).push({
          id,
          columnId,
          parentCardId: null,
          title: args.title,
          description: args.description ?? '',
          priority: !!args.priority,
          isEpic: !!args.isEpic,
          done: false,
          archived: false,
          deadline: args.deadline ?? null,
          scheduledFor: args.scheduledFor ?? null,
          tagIds: Array.isArray(args.tagIds) ? args.tagIds : [],
          order: maxOrder + 1,
          createdAt: nowTs,
          updatedAt: nowTs,
          repeat: null,
        });
      });
      return ok({ id: createdId, ok: true });
    },
  },

  update_card: {
    description: 'Update card fields by id. Provide only the fields to change in patch.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        patch: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            priority: { type: 'boolean' },
            done: { type: 'boolean' },
            deadline: { type: 'number' },
            scheduledFor: { type: 'number' },
            tagIds: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      required: ['id', 'patch'],
    },
    handler: async (args: any, client: MaitoClient) => {
      if (!args?.id || !args?.patch) return err('id and patch required');
      let found = false;
      await client.mutate((draft) => {
        const c = (draft.cards ?? []).find((c) => c.id === args.id);
        if (!c) return;
        found = true;
        Object.assign(c, args.patch, { updatedAt: now() });
      });
      if (!found) return err(`card ${args.id} not found`);
      return ok({ id: args.id, ok: true });
    },
  },

  archive_card: {
    description: 'Archive a card (soft-delete — recoverable from the Archive view).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    handler: async (args: any, client: MaitoClient) => {
      await client.mutate((draft) => {
        const c = (draft.cards ?? []).find((c) => c.id === args.id);
        if (c) { c.archived = true; c.updatedAt = now(); }
      });
      return ok({ id: args.id, ok: true });
    },
  },

  add_journal_entry: {
    description: 'Add a comment / journal entry to a card.',
    inputSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['cardId', 'body'],
    },
    handler: async (args: any, client: MaitoClient) => {
      const id = client.newId();
      await client.mutate((draft) => {
        (draft.comments ??= []).push({
          id,
          cardId: args.cardId,
          body: args.body,
          createdAt: now(),
          updatedAt: now(),
        });
      });
      return ok({ id, ok: true });
    },
  },

  search_notes: {
    description:
      'Search notes by title and body. Optionally scope to a workspace. Each hit includes workspaceId.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        workspaceId: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
    handler: async (args: any, client: MaitoClient) => {
      const q = String(args?.query ?? '').toLowerCase();
      if (!q) return err('query required');
      const { data } = await client.getState();
      const hits = (data.notes ?? [])
        .filter((n) => {
          if (args?.workspaceId && n.workspaceId !== args.workspaceId) return false;
          return (n.title?.toLowerCase() ?? '').includes(q) || (n.body?.toLowerCase() ?? '').includes(q);
        })
        .slice(0, args?.limit ?? 20)
        .map((n) => ({
          id: n.id,
          title: n.title,
          snippet: (n.body ?? '').slice(0, 200),
          workspaceId: n.workspaceId,
          updatedAt: n.updatedAt,
        }));
      return ok(hits);
    },
  },

  get_note: {
    description: 'Get full body of a note by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    handler: async (args: any, client: MaitoClient) => {
      const { data } = await client.getState();
      const n = (data.notes ?? []).find((n) => n.id === args.id);
      if (!n) return err(`note ${args.id} not found`);
      return ok({
        id: n.id,
        title: n.title,
        body: n.body,
        tags: n.tags,
        pinned: !!n.pinned,
        workspaceId: n.workspaceId,
      });
    },
  },

  create_note: {
    description:
      'Create a new note. workspaceId is required when the user has more than one workspace; otherwise the single workspace is used.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['title'],
    },
    handler: async (args: any, client: MaitoClient) => {
      const id = client.newId();
      let failure: string | null = null;
      await client.mutate((draft) => {
        const ws = resolveWorkspaceId(draft, args?.workspaceId);
        if (!ws) {
          failure =
            'workspaceId is required — multiple workspaces exist. Call list_workspaces first and pass workspaceId.';
          return;
        }
        (draft.notes ??= []).push({
          id,
          workspaceId: ws,
          title: args.title,
          body: args.body ?? '',
          tags: [],
          pinned: false,
          folderId: null,
          attachments: [],
          createdAt: now(),
          updatedAt: now(),
        });
      });
      if (failure) return err(failure);
      return ok({ id, ok: true });
    },
  },

  today_plan: {
    description:
      'Return everything scheduled for today. Optionally scope to a workspace. Each card includes workspaceId.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
      },
    },
    handler: async (args: any, client: MaitoClient) => {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const end = new Date(start); end.setDate(end.getDate() + 1);
      const startT = start.getTime();
      const endT = end.getTime();
      const { data } = await client.getState();
      const wsIdx = boardWsIndex(data);
      const cards = (data.cards ?? []).filter((c) => {
        if (c.archived || c.done) return false;
        if (args?.workspaceId && wsIdx.get(c.columnId) !== args.workspaceId) return false;
        const s = c.scheduledFor ?? null;
        const d = c.deadline ?? null;
        return (s !== null && s >= startT && s < endT) || (d !== null && d >= startT && d < endT);
      });
      return ok({
        cards: cards.map((c) => ({
          id: c.id,
          title: c.title,
          priority: !!c.priority,
          deadline: c.deadline,
          scheduledFor: c.scheduledFor,
          workspaceId: wsIdx.get(c.columnId) ?? null,
        })),
        count: cards.length,
      });
    },
  },
};

export type ToolName = keyof typeof tools;
