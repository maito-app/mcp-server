import type { MaitoClient, Snapshot } from './client.js';

function now(): number {
  return Date.now();
}

function activeWsId(s: Snapshot): string | null {
  return s.workspaces?.[0]?.id ?? null;
}

function err(msg: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
}

function ok(obj: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }],
  };
}

export const tools = {
  list_spaces: {
    description: 'List all spaces in the active workspace.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args: any, client: MaitoClient) => {
      const { data } = await client.getState();
      const ws = activeWsId(data);
      const spaces = (data.spaces ?? []).filter((s) => s.workspaceId === ws && !s.archived);
      return ok(spaces.map((s) => ({ id: s.id, name: s.name, order: s.order })));
    },
  },

  list_boards: {
    description: 'List boards, optionally scoped to a space.',
    inputSchema: {
      type: 'object',
      properties: { spaceId: { type: 'string', description: 'Filter by space id' } },
    },
    handler: async (args: any, client: MaitoClient) => {
      const { data } = await client.getState();
      let boards = (data.boards ?? []).filter((b) => !b.archived);
      if (args?.spaceId) boards = boards.filter((b) => b.spaceId === args.spaceId);
      return ok(
        boards.map((b) => ({
          id: b.id,
          name: b.name,
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
      'List cards. Filter by boardId, done, archived, priorityOnly. Returns title, priority, deadline, scheduledFor, done, tags.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        done: { type: 'boolean' },
        archived: { type: 'boolean' },
        priorityOnly: { type: 'boolean' },
        limit: { type: 'number' },
      },
    },
    handler: async (args: any, client: MaitoClient) => {
      const { data } = await client.getState();
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
        })),
      );
    },
  },

  create_card: {
    description:
      'Create a new task card. If columnId omitted, places in the first column of boardId. Either columnId or boardId is required.',
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
    description: 'Search notes by title and body. Returns id + title + snippet.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
    handler: async (args: any, client: MaitoClient) => {
      const q = String(args?.query ?? '').toLowerCase();
      if (!q) return err('query required');
      const { data } = await client.getState();
      const hits = (data.notes ?? [])
        .filter((n) => (n.title?.toLowerCase() ?? '').includes(q) || (n.body?.toLowerCase() ?? '').includes(q))
        .slice(0, args?.limit ?? 20)
        .map((n) => ({
          id: n.id,
          title: n.title,
          snippet: (n.body ?? '').slice(0, 200),
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
      return ok({ id: n.id, title: n.title, body: n.body, tags: n.tags, pinned: !!n.pinned });
    },
  },

  create_note: {
    description: 'Create a new note.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['title'],
    },
    handler: async (args: any, client: MaitoClient) => {
      const id = client.newId();
      await client.mutate((draft) => {
        const ws = activeWsId(draft) ?? '__workspace_default__';
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
      return ok({ id, ok: true });
    },
  },

  today_plan: {
    description:
      'Return everything scheduled for today: cards (scheduledFor or deadline in [startOfDay, endOfDay)).',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args: any, client: MaitoClient) => {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const end = new Date(start); end.setDate(end.getDate() + 1);
      const startT = start.getTime();
      const endT = end.getTime();
      const { data } = await client.getState();
      const cards = (data.cards ?? []).filter((c) => {
        if (c.archived || c.done) return false;
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
        })),
        count: cards.length,
      });
    },
  },
};

export type ToolName = keyof typeof tools;
