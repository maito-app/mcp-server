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

function spaceToWs(data: Snapshot): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of data.spaces ?? []) m.set(s.id, s.workspaceId);
  return m;
}

function boardToWs(data: Snapshot): Map<string, string> {
  const spaceWs = spaceToWs(data);
  const m = new Map<string, string>();
  for (const b of data.boards ?? []) {
    const ws = spaceWs.get(b.spaceId);
    if (ws) m.set(b.id, ws);
  }
  return m;
}

function colToBoard(data: Snapshot): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of data.columns ?? []) m.set(c.id, c.boardId);
  return m;
}

function colToWs(data: Snapshot): Map<string, string> {
  const bWs = boardToWs(data);
  const m = new Map<string, string>();
  for (const c of data.columns ?? []) {
    const ws = bWs.get(c.boardId);
    if (ws) m.set(c.id, ws);
  }
  return m;
}

function tagsForCard(data: Snapshot, card: any): Array<{ id: string; name: string; color?: string }> {
  const tagMap = new Map<string, any>();
  for (const t of data.tags ?? []) tagMap.set(t.id, t);
  return (card.tagIds ?? [])
    .map((id: string) => tagMap.get(id))
    .filter(Boolean)
    .map((t: any) => ({ id: t.id, name: t.name, color: t.color }));
}

function localTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  } catch {
    return 'UTC';
  }
}

function parseJwtEmail(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}

function startOfDayInTz(tz: string, dayOffset = 0): number {
  // Compute midnight of (today + dayOffset) in the given tz, return epoch ms.
  // Uses Intl to render the current date in that tz, then builds a UTC timestamp.
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === 'year')?.value);
  const m = Number(parts.find((p) => p.type === 'month')?.value);
  const d = Number(parts.find((p) => p.type === 'day')?.value);
  // Build a UTC midnight then offset back by the zone's offset at that date.
  const utcMidnight = Date.UTC(y, m - 1, d) + dayOffset * 86400000;
  // Discover tz offset at utcMidnight:
  const asString = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'shortOffset',
  }).format(new Date(utcMidnight));
  const off = /GMT([+-]\d+(?::\d+)?)/.exec(asString)?.[1] ?? '+0';
  const [hh, mm = '0'] = off.replace(/^[+-]/, '').split(':');
  const sign = off.startsWith('-') ? -1 : 1;
  const offsetMs = sign * (Number(hh) * 60 + Number(mm)) * 60_000;
  return utcMidnight - offsetMs;
}

export function buildTools(ctx: { url: string; token: string }) {
  return {
    whoami: {
      description:
        'Identify the user and their environment. Returns email, local timezone of this MCP server process, count of workspaces, and the Maito instance URL. Call this first if you need user context (e.g. "what is MY today").',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args: any, client: MaitoClient) => {
        const { data } = await client.getState();
        return ok({
          email: parseJwtEmail(ctx.token),
          timezone: localTz(),
          instanceUrl: ctx.url,
          workspaces: (data.workspaces ?? []).filter((w) => !w.archived).length,
        });
      },
    },

    list_workspaces: {
      description:
        'List all workspaces. Each workspace is an isolated container — spaces, boards, cards, notes do not cross workspace boundaries. Call this first to orient yourself.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args: any, client: MaitoClient) => {
        const { data } = await client.getState();
        const wss = (data.workspaces ?? []).filter((w) => !w.archived);
        const spaceCount = new Map<string, number>();
        for (const s of data.spaces ?? []) {
          if (!s.archived) spaceCount.set(s.workspaceId, (spaceCount.get(s.workspaceId) ?? 0) + 1);
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
        'List spaces. If workspaceId is omitted and there is exactly one workspace, uses it; otherwise returns all spaces labelled with workspaceId.',
      inputSchema: {
        type: 'object',
        properties: { workspaceId: { type: 'string' } },
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
        'List boards. Filter by workspaceId and/or spaceId. Each board includes workspaceId + spaceId.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          spaceId: { type: 'string' },
        },
      },
      handler: async (args: any, client: MaitoClient) => {
        const { data } = await client.getState();
        const spaceWs = spaceToWs(data);
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

    list_columns: {
      description:
        'List columns (statuses) of a board, ordered left-to-right. Essential before create_card / update_card (move) to pick the right column by name.',
      inputSchema: {
        type: 'object',
        properties: { boardId: { type: 'string' } },
        required: ['boardId'],
      },
      handler: async (args: any, client: MaitoClient) => {
        if (!args?.boardId) return err('boardId required');
        const { data } = await client.getState();
        const cols = (data.columns ?? [])
          .filter((c) => c.boardId === args.boardId)
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        return ok(cols.map((c) => ({ id: c.id, name: c.name, order: c.order })));
      },
    },

    list_tags: {
      description:
        'List tags. Tags in Maito are scoped to a space. Filter by spaceId or workspaceId. Use this to resolve tagIds to human-readable names before showing results.',
      inputSchema: {
        type: 'object',
        properties: {
          spaceId: { type: 'string' },
          workspaceId: { type: 'string' },
        },
      },
      handler: async (args: any, client: MaitoClient) => {
        const { data } = await client.getState();
        const spaceWs = spaceToWs(data);
        let tags = data.tags ?? [];
        if (args?.spaceId) tags = tags.filter((t) => t.spaceId === args.spaceId);
        if (args?.workspaceId)
          tags = tags.filter((t) => spaceWs.get(t.spaceId) === args.workspaceId);
        return ok(
          tags.map((t) => ({
            id: t.id,
            name: t.name,
            color: t.color,
            spaceId: t.spaceId,
            workspaceId: spaceWs.get(t.spaceId) ?? null,
          })),
        );
      },
    },

    list_cards: {
      description:
        'List cards (summaries). Filter by workspaceId, boardId, done, archived, priorityOnly. Each card includes workspaceId + boardId + columnId.',
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
        const wsIdx = colToWs(data);
        const cb = colToBoard(data);
        let cards = data.cards ?? [];
        if (args?.archived !== true) cards = cards.filter((c) => !c.archived);
        else cards = cards.filter((c) => c.archived);
        if (typeof args?.done === 'boolean') cards = cards.filter((c) => !!c.done === args.done);
        if (args?.priorityOnly) cards = cards.filter((c) => c.priority);
        if (args?.boardId) {
          const cols = new Set(
            (data.columns ?? []).filter((c) => c.boardId === args.boardId).map((c) => c.id),
          );
          cards = cards.filter((c) => cols.has(c.columnId));
        }
        if (args?.workspaceId)
          cards = cards.filter((c) => wsIdx.get(c.columnId) === args.workspaceId);
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
            boardId: cb.get(c.columnId) ?? null,
            workspaceId: wsIdx.get(c.columnId) ?? null,
          })),
        );
      },
    },

    get_card: {
      description:
        'Return a single card with full details: description, resolved tag names, journal entries (comments), subtasks (child cards), plus board/column/workspace context.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      handler: async (args: any, client: MaitoClient) => {
        const { data } = await client.getState();
        const card = (data.cards ?? []).find((c) => c.id === args?.id);
        if (!card) return err(`card ${args?.id} not found`);
        const cb = colToBoard(data);
        const wsIdx = colToWs(data);
        const journal = (data.comments ?? [])
          .filter((c) => c.cardId === card.id)
          .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
          .map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt }));
        const subtasks = (data.cards ?? [])
          .filter((c) => c.parentCardId === card.id && !c.archived)
          .map((c) => ({ id: c.id, title: c.title, done: !!c.done, columnId: c.columnId }));
        return ok({
          id: card.id,
          title: card.title,
          description: card.description ?? '',
          done: !!card.done,
          priority: !!card.priority,
          isEpic: !!card.isEpic,
          archived: !!card.archived,
          deadline: card.deadline,
          scheduledFor: card.scheduledFor,
          parentCardId: card.parentCardId,
          repeat: card.repeat ?? null,
          tags: tagsForCard(data, card),
          columnId: card.columnId,
          boardId: cb.get(card.columnId) ?? null,
          workspaceId: wsIdx.get(card.columnId) ?? null,
          createdAt: card.createdAt,
          updatedAt: card.updatedAt,
          journal,
          subtasks,
        });
      },
    },

    search_cards: {
      description:
        'Full-text search across card titles and descriptions. Optionally scope to workspaceId / boardId. Returns summaries with workspaceId + boardId.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          workspaceId: { type: 'string' },
          boardId: { type: 'string' },
          includeArchived: { type: 'boolean' },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
      handler: async (args: any, client: MaitoClient) => {
        const q = String(args?.query ?? '').toLowerCase();
        if (!q) return err('query required');
        const { data } = await client.getState();
        const wsIdx = colToWs(data);
        const cb = colToBoard(data);
        let cards = (data.cards ?? []).filter(
          (c) =>
            (args?.includeArchived || !c.archived) &&
            ((c.title?.toLowerCase() ?? '').includes(q) ||
              (c.description?.toLowerCase() ?? '').includes(q)),
        );
        if (args?.workspaceId) cards = cards.filter((c) => wsIdx.get(c.columnId) === args.workspaceId);
        if (args?.boardId) cards = cards.filter((c) => cb.get(c.columnId) === args.boardId);
        return ok(
          cards.slice(0, args?.limit ?? 30).map((c) => ({
            id: c.id,
            title: c.title,
            done: !!c.done,
            archived: !!c.archived,
            deadline: c.deadline,
            scheduledFor: c.scheduledFor,
            boardId: cb.get(c.columnId) ?? null,
            workspaceId: wsIdx.get(c.columnId) ?? null,
            snippet: (c.description ?? '').slice(0, 160),
          })),
        );
      },
    },

    create_card: {
      description:
        'Create a task card. Either columnId (precise) or boardId (uses first column). Workspace is inherited from the column/board.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          columnId: { type: 'string' },
          boardId: { type: 'string' },
          priority: { type: 'boolean' },
          isEpic: { type: 'boolean' },
          parentCardId: { type: 'string', description: 'Create as a subtask of this card.' },
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
            parentCardId: args.parentCardId ?? null,
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
      description:
        'Update card fields. patch can include columnId to MOVE a card to another column (e.g. mark as Done by moving to Done column). Set done:true to mark finished. Omit fields you do not want to change.',
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
              columnId: { type: 'string', description: 'Move card to this column' },
              deadline: { type: 'number' },
              scheduledFor: { type: 'number' },
              tagIds: { type: 'array', items: { type: 'string' } },
              parentCardId: { type: ['string', 'null'] },
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
      description: 'Archive a card (soft-delete — recoverable from Archive view).',
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
      description: 'Add a comment / journal entry to a card. Use for status updates, notes, decisions.',
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

    create_space: {
      description: 'Create a new space (top-level container) within a workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          name: { type: 'string' },
          icon: { type: 'string' },
          color: { type: 'string' },
        },
        required: ['name'],
      },
      handler: async (args: any, client: MaitoClient) => {
        let createdId = '';
        let failure: string | null = null;
        await client.mutate((draft) => {
          const ws = resolveWorkspaceId(draft, args?.workspaceId);
          if (!ws) {
            failure = 'workspaceId required — multiple workspaces exist.';
            return;
          }
          const id = client.newId();
          createdId = id;
          const maxOrder = Math.max(
            -1,
            ...(draft.spaces ?? []).filter((s) => s.workspaceId === ws).map((s) => s.order ?? 0),
          );
          (draft.spaces ??= []).push({
            id,
            workspaceId: ws,
            name: args.name,
            icon: args.icon ?? '📁',
            color: args.color ?? '#6366f1',
            order: maxOrder + 1,
            archived: false,
            createdAt: now(),
          });
        });
        if (failure) return err(failure);
        return ok({ id: createdId, ok: true });
      },
    },

    create_board: {
      description:
        'Create a new board inside a space. The board is created with 3 default columns: Todo / In Progress / Done.',
      inputSchema: {
        type: 'object',
        properties: {
          spaceId: { type: 'string' },
          name: { type: 'string' },
          displayMode: { type: 'string', enum: ['all', 'epics', 'tasks'] },
          layout: { type: 'string', enum: ['board', 'list'] },
        },
        required: ['spaceId', 'name'],
      },
      handler: async (args: any, client: MaitoClient) => {
        let boardId = '';
        await client.mutate((draft) => {
          const id = client.newId();
          boardId = id;
          const maxOrder = Math.max(
            -1,
            ...(draft.boards ?? []).filter((b) => b.spaceId === args.spaceId).map((b) => b.order ?? 0),
          );
          (draft.boards ??= []).push({
            id,
            spaceId: args.spaceId,
            parentBoardId: null,
            name: args.name,
            order: maxOrder + 1,
            createdAt: now(),
            displayMode: args.displayMode ?? 'all',
            layout: args.layout ?? 'board',
            archived: false,
          });
          const cols = ['Todo', 'In Progress', 'Done'];
          cols.forEach((name, i) => {
            (draft.columns ??= []).push({
              id: client.newId(),
              boardId: id,
              name,
              order: i,
            });
          });
        });
        return ok({ id: boardId, ok: true });
      },
    },

    create_column: {
      description: 'Create a new column (status) in a board.',
      inputSchema: {
        type: 'object',
        properties: {
          boardId: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['boardId', 'name'],
      },
      handler: async (args: any, client: MaitoClient) => {
        const id = client.newId();
        await client.mutate((draft) => {
          const maxOrder = Math.max(
            -1,
            ...(draft.columns ?? []).filter((c) => c.boardId === args.boardId).map((c) => c.order ?? 0),
          );
          (draft.columns ??= []).push({
            id,
            boardId: args.boardId,
            name: args.name,
            order: maxOrder + 1,
          });
        });
        return ok({ id, ok: true });
      },
    },

    search_notes: {
      description:
        'Search notes by title and body. Optionally scope to workspace. Each hit includes workspaceId.',
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
            return (
              (n.title?.toLowerCase() ?? '').includes(q) ||
              (n.body?.toLowerCase() ?? '').includes(q)
            );
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
        'Create a new note. workspaceId is required when multiple workspaces exist.',
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
              'workspaceId required — multiple workspaces exist. Call list_workspaces first.';
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
        'Return cards scheduled for today in the local timezone of this MCP process (use whoami to see which tz). Filter by workspaceId. Pass dayOffset=1 for "tomorrow", -1 for "yesterday".',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          dayOffset: { type: 'number', description: '0=today, 1=tomorrow, -1=yesterday' },
        },
      },
      handler: async (args: any, client: MaitoClient) => {
        const tz = localTz();
        const offset = typeof args?.dayOffset === 'number' ? args.dayOffset : 0;
        const startT = startOfDayInTz(tz, offset);
        const endT = startT + 86400_000;
        const { data } = await client.getState();
        const wsIdx = colToWs(data);
        const cards = (data.cards ?? []).filter((c) => {
          if (c.archived || c.done) return false;
          if (args?.workspaceId && wsIdx.get(c.columnId) !== args.workspaceId) return false;
          const s = c.scheduledFor ?? null;
          const d = c.deadline ?? null;
          return (s !== null && s >= startT && s < endT) || (d !== null && d >= startT && d < endT);
        });
        return ok({
          timezone: tz,
          window: { start: startT, end: endT },
          count: cards.length,
          cards: cards.map((c) => ({
            id: c.id,
            title: c.title,
            priority: !!c.priority,
            deadline: c.deadline,
            scheduledFor: c.scheduledFor,
            columnId: c.columnId,
            workspaceId: wsIdx.get(c.columnId) ?? null,
          })),
        });
      },
    },

    recent_activity: {
      description:
        'Return the activity feed. Shows card_created, card_done, card_moved, board_created, space_created, note_created etc. Use this to answer "what did I do yesterday / last week".',
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'number', description: 'Epoch ms lower bound.' },
          workspaceId: { type: 'string' },
          limit: { type: 'number' },
        },
      },
      handler: async (args: any, client: MaitoClient) => {
        const { data } = await client.getState();
        const spaceWs = spaceToWs(data);
        const bWs = boardToWs(data);
        const cWs = colToWs(data);
        const cardCol = new Map<string, string>();
        for (const c of data.cards ?? []) cardCol.set(c.id, c.columnId);
        const wsFor = (ev: any): string | null => {
          if (ev.cardId) {
            const col = cardCol.get(ev.cardId);
            return col ? cWs.get(col) ?? null : null;
          }
          if (ev.boardId) return bWs.get(ev.boardId) ?? null;
          if (ev.spaceId) return spaceWs.get(ev.spaceId) ?? null;
          return null;
        };
        let events = (data.activity ?? []).slice();
        events.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
        if (typeof args?.since === 'number') events = events.filter((e) => (e.ts ?? 0) >= args.since);
        if (args?.workspaceId) events = events.filter((e) => wsFor(e) === args.workspaceId);
        events = events.slice(0, args?.limit ?? 50);
        return ok(
          events.map((e) => ({
            id: e.id,
            ts: e.ts,
            type: e.type,
            title: e.title,
            meta: e.meta,
            cardId: e.cardId,
            boardId: e.boardId,
            spaceId: e.spaceId,
            noteId: e.noteId,
            workspaceId: wsFor(e),
          })),
        );
      },
    },
  };
}

export type Tools = ReturnType<typeof buildTools>;
export type ToolName = keyof Tools;

export const INSTRUCTIONS = `# Maito MCP server

Maito is a personal productivity system with this hierarchy:

  Workspace → Space → Board → Column → Card
                                      ↘ Journal entries (comments), Subtasks
  Workspace → Note

A user can have MULTIPLE workspaces (e.g. "Personal" + "Work"). Nothing crosses workspace boundaries.

## Getting your bearings

Call these in order when uncertain:

1. \`whoami\` — email, local timezone, workspace count.
2. \`list_workspaces\` — pick one explicitly if there is more than one.
3. \`list_spaces({ workspaceId })\` → \`list_boards({ spaceId })\` → \`list_columns({ boardId })\`.

## Reading

- \`list_cards\` is summaries. Use \`get_card(id)\` for full details incl. description, journal, subtasks.
- \`today_plan\` uses the timezone from whoami. Pass \`dayOffset: 1\` for tomorrow, \`-1\` for yesterday.
- \`search_cards\` / \`search_notes\` for fuzzy lookup.
- \`recent_activity({ since })\` answers "what happened recently" questions.

## Writing

- \`create_card\` wants columnId (or boardId → first column).
- \`update_card({ id, patch: { columnId: X } })\` MOVES a card. Same tool marks done via \`patch.done\`.
- \`archive_card\` is soft-delete. There is no hard delete.
- \`create_space\`, \`create_board\` (spawns default Todo/In Progress/Done columns), \`create_column\`.
- \`add_journal_entry\` posts a comment on a card.

## Scope

Tags are per-space. Notes are per-workspace. Cards belong to a workspace indirectly via column → board → space → workspace.

## Safety

Prefer reading before writing. When ambiguous (multi-workspace user, unclear column), ASK the user instead of guessing. Don't batch destructive operations without confirmation.`;
