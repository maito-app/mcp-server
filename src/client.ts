// Клиент к Maito backend. Оборачивает GET/PUT /api/state.
// В v0.1 используем "full snapshot diff" — простой подход, достаточно для single-user.
import { nanoid } from './nanoid.js';

export type Snapshot = {
  workspaces?: any[];
  spaces?: any[];
  boards?: any[];
  columns?: any[];
  cards?: any[];
  comments?: any[];
  tags?: any[];
  notes?: any[];
  noteFolders?: any[];
  activity?: any[];
};

export class MaitoClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async health(): Promise<boolean> {
    const r = await fetch(`${this.baseUrl}/api/health`);
    return r.ok;
  }

  async getState(): Promise<{ data: Snapshot; version: number }> {
    const r = await fetch(`${this.baseUrl}/api/state`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!r.ok) throw new Error(`GET /api/state: ${r.status}`);
    return r.json();
  }

  /**
   * Scoped read endpoints — tiny responses, no full-state download.
   * Use these for every read path; `getState` stays for `mutate` only.
   */
  async view<T = any>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
    const qs = params
      ? '?' + Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')
      : '';
    const r = await fetch(`${this.baseUrl}/api/view/${path}${qs}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (r.status === 404) throw new Error(`not_found: ${path}`);
    if (!r.ok) throw new Error(`GET /api/view/${path}: ${r.status}`);
    return r.json();
  }

  async putState(data: Snapshot, expectedVersion: number): Promise<number> {
    const r = await fetch(`${this.baseUrl}/api/state`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ data, expectedVersion }),
    });
    if (r.status === 409) {
      throw new Error('version_conflict');
    }
    if (!r.ok) throw new Error(`PUT /api/state: ${r.status}`);
    const body = (await r.json()) as { version: number };
    return body.version;
  }

  /** Read-modify-write с простым retry на optimistic concurrency. */
  async mutate(fn: (draft: Snapshot) => void | Promise<void>): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data, version } = await this.getState();
      const draft = structuredClone(data);
      await fn(draft);
      try {
        await this.putState(draft, version);
        return;
      } catch (e: any) {
        if (String(e?.message).includes('version_conflict')) {
          continue; // retry
        }
        throw e;
      }
    }
    throw new Error('mutate: too many version conflicts');
  }

  newId(): string {
    return nanoid();
  }
}
