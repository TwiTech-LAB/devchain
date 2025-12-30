/**
 * URL filter schema utilities for Board page
 *
 * Goals
 * - Strict parsing with normalization and de-duplication
 * - Canonical serialization with stable key + value ordering
 * - Forward compatible: ignore unknown/invalid inputs
 * - Booleans encoded as 0|1
 *
 * Supported filters (long key → short key)
 * - archived → ar (enum: active|archived|all, default: active) [server-side, triggers refetch]
 * - status   → st (multi) [client-side filter]
 * - parent   → p
 * - agent    → a
 * - tags     → t (multi)
 * - q        → q
 * - sub      → sb (boolean 0|1)
 * - sort     → s
 * - view     → v (enum: kanban|list, default: kanban)
 * - page     → pg (number, default: 1)
 * - pageSize → ps (number, default: 25)
 */

import { z } from 'zod';

export type BoardFilterParams = {
  archived?: 'active' | 'archived' | 'all'; // fetch type: active (default), archived, or all
  status?: string[]; // e.g. ["in_progress", "review"]
  parent?: string; // epic id or slug
  agent?: string; // agent id or name slug
  tags?: string[]; // tag labels (comma-separated)
  q?: string; // free-text search
  sub?: boolean; // include sub-epics
  sort?: string; // sort key
  view?: 'kanban' | 'list'; // view mode (default: kanban)
  page?: number; // pagination page (default: 1)
  pageSize?: number; // items per page (default: 25)
};

export const ParamKeyMap = {
  archived: 'ar',
  status: 'st',
  parent: 'p',
  agent: 'a',
  tags: 't',
  q: 'q',
  sub: 'sb',
  sort: 's',
  view: 'v',
  page: 'pg',
  pageSize: 'ps',
} as const;

export const ShortToLongKeyMap: Record<string, keyof BoardFilterParams> = Object.fromEntries(
  Object.entries(ParamKeyMap).map(([longKey, shortKey]) => [
    shortKey,
    longKey as keyof BoardFilterParams,
  ]),
);

// Canonical key order for serialization (long keys)
// Note: 'archived' is first as it's a server-side filter that triggers refetch
const PARAM_ORDER: (keyof BoardFilterParams)[] = [
  'archived',
  'view',
  'status',
  'parent',
  'agent',
  'tags',
  'q',
  'sub',
  'sort',
  'page',
  'pageSize',
];

// Basic validators (intentionally permissive for forward-compat)
const idLike = z
  .string()
  .trim()
  .min(1)
  .refine((s) => /\S/.test(s), { message: 'must contain non-space' });

const csv = (value: string | string[] | null | undefined): string[] => {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value.join(',') : value;
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
};

const dedupeSorted = (arr: string[]): string[] => {
  const set = new Set(
    arr
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      // case-insensitive de-duplication by lower-cased representation
      .map((s) => ({ key: s.toLowerCase(), val: s }))
      .reduce(
        (acc, { key, val }) => (acc.has(key) ? acc : acc.set(key, val)),
        new Map<string, string>(),
      )
      .values(),
  );
  return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
};

const normalize = (params: BoardFilterParams): BoardFilterParams => {
  const out: BoardFilterParams = {};
  if (params.archived === 'active' || params.archived === 'archived' || params.archived === 'all')
    out.archived = params.archived;
  if (params.view === 'kanban' || params.view === 'list') out.view = params.view;
  if (params.status && params.status.length) out.status = dedupeSorted(params.status);
  if (params.parent && idLike.safeParse(params.parent).success) out.parent = params.parent.trim();
  if (params.agent && idLike.safeParse(params.agent).success) out.agent = params.agent.trim();
  if (params.tags && params.tags.length) out.tags = dedupeSorted(params.tags);
  if (params.q && params.q.trim().length) out.q = params.q.trim();
  if (typeof params.sub === 'boolean') out.sub = params.sub;
  if (params.sort && params.sort.trim().length) out.sort = params.sort.trim();
  if (typeof params.page === 'number' && params.page >= 1) out.page = params.page;
  if (typeof params.pageSize === 'number' && params.pageSize >= 1) out.pageSize = params.pageSize;
  return out;
};

/**
 * Parse known filter params from a URL, search string, or URLSearchParams.
 * Accepts both long and short keys; ignores unknown/invalid values.
 */
export function parseBoardFilters(
  input?: string | URL | URLSearchParams | Location,
): BoardFilterParams {
  let sp: URLSearchParams;
  if (!input) {
    sp = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  } else if (input instanceof URLSearchParams) {
    sp = input;
  } else if (typeof input === 'string') {
    const s = input.startsWith('?') ? input : `?${input}`;
    sp = new URLSearchParams(s);
  } else if (typeof window !== 'undefined' && 'search' in (input as Location)) {
    sp = new URLSearchParams((input as Location).search ?? '');
  } else {
    const url = input as URL;
    sp = new URLSearchParams(url.search ?? '');
  }

  const get = (key: string) => sp.get(key);

  // Helper: read by both long and short keys
  const read = (longKey: keyof BoardFilterParams): string | null => {
    const shortKey = ParamKeyMap[longKey];
    return get(longKey as string) ?? get(shortKey);
  };

  const status = csv(read('status'));
  const tags = csv(read('tags'));
  const parent = read('parent') ?? undefined;
  const agent = read('agent') ?? undefined;
  const q = read('q') ?? undefined;

  const subRaw = read('sub');
  const sub = subRaw != null ? subRaw === '1' || subRaw.toLowerCase() === 'true' : undefined;

  const sort = read('sort') ?? undefined;

  // View: enum 'kanban' | 'list' (default: kanban for backward compatibility)
  const viewRaw = read('view');
  const view: 'kanban' | 'list' | undefined =
    viewRaw === 'list' ? 'list' : viewRaw === 'kanban' ? 'kanban' : undefined;

  // Archived: enum 'active' | 'archived' | 'all' (default: active)
  const archivedRaw = read('archived');
  const archived: 'active' | 'archived' | 'all' | undefined =
    archivedRaw === 'archived'
      ? 'archived'
      : archivedRaw === 'all'
        ? 'all'
        : archivedRaw === 'active'
          ? 'active'
          : undefined;

  // Page and pageSize: numbers (default: 1 and 25 respectively)
  const pageRaw = read('page');
  const page = pageRaw != null ? parseInt(pageRaw, 10) : undefined;

  const pageSizeRaw = read('pageSize');
  const pageSize = pageSizeRaw != null ? parseInt(pageSizeRaw, 10) : undefined;

  return normalize({ archived, status, parent, agent, tags, q, sub, sort, view, page, pageSize });
}

/** Return URLSearchParams with canonical key order and value normalization (short keys). */
export function toSearchParams(params: BoardFilterParams): URLSearchParams {
  const p = normalize(params);
  const sp = new URLSearchParams();

  const set = (
    keyLong: keyof BoardFilterParams,
    value: string | string[] | boolean | number | undefined,
  ) => {
    const shortKey = ParamKeyMap[keyLong];
    if (value == null) return;
    if (Array.isArray(value)) {
      if (!value.length) return;
      // Store raw comma-separated value; URLSearchParams will percent-encode on toString(),
      // but get(key) will return the raw string with commas, which is useful in-code.
      sp.set(shortKey, dedupeSorted(value).join(','));
    } else if (typeof value === 'boolean') {
      sp.set(shortKey, value ? '1' : '0');
    } else if (typeof value === 'number') {
      sp.set(shortKey, String(value));
    } else if (typeof value === 'string' && value.trim().length) {
      sp.set(shortKey, value.trim());
    }
  };

  for (const key of PARAM_ORDER) {
    set(key, p[key as keyof BoardFilterParams]);
  }

  return sp;
}

/** Serialize to a canonical query string (without leading ?), leaving commas unencoded. */
export function serializeBoardFilters(params: BoardFilterParams): string {
  const p = normalize(params);
  const pairs: string[] = [];

  const push = (
    keyLong: keyof BoardFilterParams,
    value: string | string[] | boolean | number | undefined,
  ) => {
    if (value == null) return;
    const k = ParamKeyMap[keyLong];
    if (Array.isArray(value)) {
      if (!value.length) return;
      const joined = dedupeSorted(value)
        .map((v) => encodeURIComponent(v))
        .join(','); // keep comma literal
      pairs.push(`${k}=${joined}`);
    } else if (typeof value === 'boolean') {
      pairs.push(`${k}=${value ? '1' : '0'}`);
    } else if (typeof value === 'number') {
      pairs.push(`${k}=${value}`);
    } else if (typeof value === 'string' && value.trim().length) {
      pairs.push(`${k}=${encodeURIComponent(value.trim())}`);
    }
  };

  for (const key of PARAM_ORDER) {
    push(key, p[key as keyof BoardFilterParams]);
  }

  return pairs.join('&');
}

/** Merge current URL params with delta, returning a canonical query string. */
export function mergeBoardFilters(
  current: string | URL | URLSearchParams | Location | undefined,
  delta: BoardFilterParams,
): string {
  const base = parseBoardFilters(current);
  const merged: BoardFilterParams = { ...base };

  // Merge arrays as unions; primitives override
  if (delta.status) {
    merged.status = dedupeSorted([...(base.status ?? []), ...delta.status]);
  }
  if (delta.tags) {
    merged.tags = dedupeSorted([...(base.tags ?? []), ...delta.tags]);
  }
  if (delta.archived !== undefined) merged.archived = delta.archived;
  if (delta.parent !== undefined) merged.parent = delta.parent;
  if (delta.agent !== undefined) merged.agent = delta.agent;
  if (delta.q !== undefined) merged.q = delta.q;
  if (delta.sub !== undefined) merged.sub = delta.sub;
  if (delta.sort !== undefined) merged.sort = delta.sort;
  if (delta.view !== undefined) merged.view = delta.view;
  if (delta.page !== undefined) merged.page = delta.page;
  if (delta.pageSize !== undefined) merged.pageSize = delta.pageSize;

  return serializeBoardFilters(merged);
}

/** Convenience: build full URL given a base path (no existing query). */
export function buildBoardFiltersUrl(basePath: string, params: BoardFilterParams): string {
  const qs = serializeBoardFilters(params);
  return qs ? `${basePath}?${qs}` : basePath;
}
