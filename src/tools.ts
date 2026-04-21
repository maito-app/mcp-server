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

function resolveWorkspaceIdFromList(workspaces: Array<{ id: string }>, argWs: unknown): string | null {
  if (typeof argWs === 'string' && argWs) {
    return workspaces.find((w) => w.id === argWs)?.id ?? null;
  }
  if (workspaces.length === 1) return workspaces[0].id;
  return null;
}

function resolveWorkspaceIdFromDraft(draft: Snapshot, argWs: unknown): string | null {
  const all = (draft.workspaces ?? []).filter((w) => !w.archived);
  if (typeof argWs === 'string' && argWs) {
    return all.find((w) => w.id === argWs)?.id ?? null;
  }
  if (all.length === 1) return all[0].id;
  return null;
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
  const utcMidnight = Date.UTC(y, m - 1, d) + dayOffset * 86400000;
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
        'Identify the user and their environment. Returns email, local timezone of this MCP process, the Maito instance URL, and number of workspaces. Call first when you need user context.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args: any, client: MaitoClient) => {
        const wss = await client.view<any[]>('workspaces');
        return ok({
          email: parseJwtEmail(ctx.token),
          timezone: localTz(),
          instanceUrl: ctx.url,
          workspaces: wss.length,
        });
      },
    },

    list_workspaces: {
      description:
        'List all workspaces. Each workspace is an isolated container — spaces/boards/cards/notes do not cross workspace boundaries. Call this first to orient yourself.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args: any, client: MaitoClient) => {
        return ok(await client.view('workspaces'));
      },
    },

    list_spaces: {
      description:
        'List spaces. If workspaceId is omitted and there is exactly one workspace, uses it; otherwise returns spaces from all workspaces labelled with workspaceId.',
      inputSchema: {
        type: 'object',
        properties: { workspaceId: { type: 'string' } },
      },
      handler: async (args: any, client: MaitoClient) => {
        return ok(await client.view('spaces', { workspaceId: args?.workspaceId }));
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
        return ok(
          await client.view('boards', {
            workspaceId: args?.workspaceId,
            spaceId: args?.spaceId,
          }),
        );
      },
    },

    list_columns: {
      description:
        'List columns (statuses) of a board, ordered left-to-right. Use before create_card / update_card to pick the right column by name.',
      inputSchema: {
        type: 'object',
        properties: { boardId: { type: 'string' } },
        required: ['boardId'],
      },
      handler: async (args: any, client: MaitoClient) => {
        if (!args?.boardId) return err('boardId required');
        return ok(await client.view('columns', { boardId: args.boardId }));
      },
    },

    list_tags: {
      description:
        'List tags. Tags are scoped to a space. Filter by spaceId or workspaceId. Use to resolve tagIds to human-readable names.',
      inputSchema: {
        type: 'object',
        properties: {
          spaceId: { type: 'string' },
          workspaceId: { type: 'string' },
        },
      },
      handler: async (args: any, client: MaitoClient) => {
        return ok(
          await client.view('tags', {
            spaceId: args?.spaceId,
            workspaceId: args?.workspaceId,
          }),
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
        return ok(
          await client.view('cards', {
            workspaceId: args?.workspaceId,
            boardId: args?.boardId,
            done: typeof args?.done === 'boolean' ? String(args.done) : undefined,
            archived: args?.archived === true ? 'true' : undefined,
            priorityOnly: args?.priorityOnly === true ? 'true' : undefined,
            limit: args?.limit,
          }),
        );
      },
    },

    get_card: {
      description:
        'Return a single card with full details: description, resolved tag names, journal entries, subtasks, plus board/column/workspace context.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      handler: async (args: any, client: MaitoClient) => {
        if (!args?.id) return err('id required');
        try {
          return ok(await client.view(`card/${encodeURIComponent(args.id)}`));
        } catch (e: any) {
          if (String(e?.message).startsWith('not_found')) return err(`card ${args.id} not found`);
          throw e;
        }
      },
    },

    search_cards: {
      description:
        'Full-text search across card titles and descriptions. Optionally scope to workspaceId / boardId.',
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
        if (!args?.query) return err('query required');
        return ok(
          await client.view('cards', {
            workspaceId: args?.workspaceId,
            boardId: args?.boardId,
            query: args.query,
            archived: args?.includeArchived === true ? 'true' : undefined,
            limit: args?.limit ?? 30,
          }),
        );
      },
    },

    create_card: {
      description:
        'Create a task card. Either columnId (precise) or boardId (uses first column). Workspace inherited from column/board.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          columnId: { type: 'string' },
          boardId: { type: 'string' },
          priority: { type: 'boolean' },
          isEpic: { type: 'boolean' },
          parentCardId: { type: 'string' },
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
        'Update card fields. patch.columnId MOVES the card to another column (mark Done by moving, or pass done:true). Omit fields you do not want to change.',
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
              columnId: { type: 'string' },
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
          const ws = resolveWorkspaceIdFromDraft(draft, args?.workspaceId);
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
        'Create a new board inside a space. Spawns 3 default columns: Todo / In Progress / Done.',
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
          ['Todo', 'In Progress', 'Done'].forEach((name, i) => {
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
        'Search notes by title and body. Optionally scope to workspace.',
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
        if (!args?.query) return err('query required');
        return ok(
          await client.view('notes', {
            query: args.query,
            workspaceId: args?.workspaceId,
            limit: args?.limit ?? 20,
          }),
        );
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
        if (!args?.id) return err('id required');
        try {
          return ok(await client.view(`note/${encodeURIComponent(args.id)}`));
        } catch (e: any) {
          if (String(e?.message).startsWith('not_found')) return err(`note ${args.id} not found`);
          throw e;
        }
      },
    },

    create_note: {
      description: 'Create a new note. workspaceId required when multiple workspaces exist.',
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
          const ws = resolveWorkspaceIdFromDraft(draft, args?.workspaceId);
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
        'Return cards scheduled for today in the local timezone of this MCP process. Pass dayOffset=1 for tomorrow, -1 for yesterday. Filter by workspaceId.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          dayOffset: { type: 'number' },
        },
      },
      handler: async (args: any, client: MaitoClient) => {
        const tz = localTz();
        const offset = typeof args?.dayOffset === 'number' ? args.dayOffset : 0;
        const start = startOfDayInTz(tz, offset);
        const end = start + 86400_000;
        const res = await client.view<any>('today', {
          start,
          end,
          workspaceId: args?.workspaceId,
        });
        return ok({ timezone: tz, ...res });
      },
    },

    recent_activity: {
      description:
        'Activity feed: card_created, card_done, card_moved, board_created, space_created, note_created, etc. Answers "what did I do recently".',
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'number', description: 'Epoch ms lower bound' },
          workspaceId: { type: 'string' },
          limit: { type: 'number' },
        },
      },
      handler: async (args: any, client: MaitoClient) => {
        return ok(
          await client.view('activity', {
            since: args?.since,
            workspaceId: args?.workspaceId,
            limit: args?.limit ?? 50,
          }),
        );
      },
    },
  };
}

// Re-export for code that builds without `ctx` (legacy test imports).
export function _resolveWorkspaceFromList(ws: Array<{ id: string }>, arg: unknown): string | null {
  return resolveWorkspaceIdFromList(ws, arg);
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
