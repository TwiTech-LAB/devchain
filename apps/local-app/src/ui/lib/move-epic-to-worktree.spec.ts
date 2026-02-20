import { moveEpicToWorktree, type MoveProgress } from './move-epic-to-worktree';

// ── Test data factories ───────────────────────────────────────────

function makeEpic(overrides: Record<string, unknown> = {}) {
  return {
    id: 'root-1',
    projectId: 'proj-src',
    title: 'Root Epic',
    description: 'desc',
    statusId: 'st-1',
    parentId: null,
    agentId: 'agent-1',
    version: 1,
    data: null,
    skillsRequired: null,
    tags: ['tag-a'],
    ...overrides,
  };
}

function makeComment(authorName = 'Bot', content = 'Hello') {
  return { authorName, content };
}

// ── Fetch mock helpers ────────────────────────────────────────────

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

/** Build a routing fetch mock from a map of URL-pattern → handler */
function createRoutingFetch(
  routes: Array<{ match: (url: string, init?: RequestInit) => boolean; handle: FetchHandler }>,
) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    for (const route of routes) {
      if (route.match(url, init)) {
        return route.handle(url, init);
      }
    }
    return { ok: true, json: async () => ({}), text: async () => '' } as Response;
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
    statusText: status === 200 ? 'OK' : 'Error',
  } as Response;
}

function errorResponse(status = 500, body = 'Internal Server Error'): Response {
  return {
    ok: false,
    status,
    json: async () => ({ message: body }),
    text: async () => body,
    statusText: body,
  } as Response;
}

// ── Tests ─────────────────────────────────────────────────────────

describe('moveEpicToWorktree', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  // ── Flat epic (no children) ─────────────────────────────────────

  describe('flat epic (no children, no comments)', () => {
    it('extracts, creates in destination, and deletes source', async () => {
      const fetchCalls: string[] = [];

      global.fetch = createRoutingFetch([
        // Phase 4: DELETE source — must be before GET to match first by method
        {
          match: (url, init) => url === '/api/epics/root-1' && init?.method === 'DELETE',
          handle: async (url) => {
            fetchCalls.push(`DELETE ${url}`);
            return jsonResponse({});
          },
        },
        // Phase 1: GET root epic
        {
          match: (url) => url === '/api/epics/root-1' && !url.includes('?'),
          handle: async () => jsonResponse(makeEpic()),
        },
        // Phase 1: GET children of root (empty)
        {
          match: (url) => url.startsWith('/api/epics?parentId=root-1'),
          handle: async () => jsonResponse({ items: [], total: 0, limit: 1000, offset: 0 }),
        },
        // Phase 1: GET comments for root (empty)
        {
          match: (url) => url.startsWith('/api/epics/root-1/comments'),
          handle: async () => jsonResponse({ items: [], total: 0, limit: 1000, offset: 0 }),
        },
        // Phase 2: GET source statuses
        {
          match: (url) => url.startsWith('/api/statuses?projectId=proj-src'),
          handle: async () =>
            jsonResponse({ items: [{ id: 'st-1', label: 'New', color: '#ccc', position: 0 }] }),
        },
        // Phase 2: GET destination statuses
        {
          match: (url) => url.startsWith('/wt/my-wt/api/statuses?projectId=proj-dest'),
          handle: async () =>
            jsonResponse({ items: [{ id: 'dst-st-1', label: 'New', color: '#ccc', position: 0 }] }),
        },
        // Phase 3: POST create epic in destination
        {
          match: (url, init) => url === '/wt/my-wt/api/epics' && init?.method === 'POST',
          handle: async (url) => {
            fetchCalls.push(`POST ${url}`);
            return jsonResponse({ id: 'dest-root-1' });
          },
        },
      ]);

      const result = await moveEpicToWorktree({
        epicId: 'root-1',
        destWorktreeName: 'my-wt',
        destProjectId: 'proj-dest',
        statusMap: {},
        agentMap: { 'agent-1': 'dest-agent-1' },
      });

      expect(result.destEpicId).toBe('dest-root-1');
      expect(result.warnings).toEqual([]);
      expect(fetchCalls).toContain('POST /wt/my-wt/api/epics');
      expect(fetchCalls).toContain('DELETE /api/epics/root-1');
    });
  });

  // ── Deep tree (3 levels) with pagination ────────────────────────

  describe('recursive extraction with 3-level deep tree', () => {
    it('extracts all descendants via BFS and creates in DFS order', async () => {
      const createdEpics: Array<{ title: string; parentId: string | null }> = [];

      global.fetch = createRoutingFetch([
        // Root epic
        {
          match: (url) => url === '/api/epics/root-1',
          handle: async () => jsonResponse(makeEpic({ id: 'root-1', title: 'Root' })),
        },
        // Root children: child-1
        {
          match: (url) => url.startsWith('/api/epics?parentId=root-1'),
          handle: async () =>
            jsonResponse({
              items: [makeEpic({ id: 'child-1', parentId: 'root-1', title: 'Child 1' })],
              total: 1,
              limit: 1000,
              offset: 0,
            }),
        },
        // child-1 children: grandchild-1
        {
          match: (url) => url.startsWith('/api/epics?parentId=child-1'),
          handle: async () =>
            jsonResponse({
              items: [makeEpic({ id: 'gc-1', parentId: 'child-1', title: 'Grandchild 1' })],
              total: 1,
              limit: 1000,
              offset: 0,
            }),
        },
        // grandchild-1 has no children
        {
          match: (url) => url.startsWith('/api/epics?parentId=gc-1'),
          handle: async () => jsonResponse({ items: [], total: 0, limit: 1000, offset: 0 }),
        },
        // Comments — all empty
        {
          match: (url) => url.includes('/comments'),
          handle: async () => jsonResponse({ items: [], total: 0, limit: 1000, offset: 0 }),
        },
        // Source statuses
        {
          match: (url) => url.startsWith('/api/statuses'),
          handle: async () =>
            jsonResponse({ items: [{ id: 'st-1', label: 'New', color: '#ccc', position: 0 }] }),
        },
        // Dest statuses
        {
          match: (url) => url.startsWith('/wt/wt-1/api/statuses?projectId='),
          handle: async () =>
            jsonResponse({ items: [{ id: 'dst-st-1', label: 'New', color: '#ccc', position: 0 }] }),
        },
        // Create epics in destination
        {
          match: (url, init) => url === '/wt/wt-1/api/epics' && init?.method === 'POST',
          handle: async (_url, init) => {
            const body = JSON.parse(init!.body as string);
            createdEpics.push({ title: body.title, parentId: body.parentId });
            return jsonResponse({ id: `dest-${body.title.toLowerCase().replace(/\s/g, '-')}` });
          },
        },
        // DELETE source
        {
          match: (_url, init) => init?.method === 'DELETE',
          handle: async () => jsonResponse({}),
        },
      ]);

      const result = await moveEpicToWorktree({
        epicId: 'root-1',
        destWorktreeName: 'wt-1',
        destProjectId: 'proj-dest',
        statusMap: {},
        agentMap: { 'agent-1': 'da-1' },
      });

      expect(result.destEpicId).toBe('dest-root');
      // DFS order: root (parentId=null), child (parentId=dest-root), grandchild (parentId=dest-child-1)
      expect(createdEpics).toHaveLength(3);
      expect(createdEpics[0]).toEqual({ title: 'Root', parentId: null });
      expect(createdEpics[1]).toEqual({ title: 'Child 1', parentId: 'dest-root' });
      expect(createdEpics[2]).toEqual({ title: 'Grandchild 1', parentId: 'dest-child-1' });
    });
  });

  // ── Status mapping ──────────────────────────────────────────────

  describe('status mapping', () => {
    function setupStatusTest(
      sourceStatuses: Array<{ id: string; label: string; color: string; position: number }>,
      destStatuses: Array<{ id: string; label: string; color: string; position: number }>,
    ) {
      const postCalls: Array<{ url: string; body: unknown }> = [];
      let statusCounter = 0;

      global.fetch = createRoutingFetch([
        {
          match: (url) => url === '/api/epics/root-1',
          handle: async () => jsonResponse(makeEpic({ statusId: sourceStatuses[0]?.id ?? 'st-1' })),
        },
        {
          match: (url) => url.startsWith('/api/epics?parentId='),
          handle: async () => jsonResponse({ items: [], total: 0, limit: 1000, offset: 0 }),
        },
        {
          match: (url) => url.includes('/comments'),
          handle: async () => jsonResponse({ items: [], total: 0, limit: 1000, offset: 0 }),
        },
        {
          match: (url) => url.startsWith('/api/statuses'),
          handle: async () => jsonResponse({ items: sourceStatuses }),
        },
        {
          match: (url) => url.startsWith('/wt/wt-1/api/statuses') && !url.includes('?'),
          handle: async (_url, init) => {
            if (init?.method === 'POST') {
              statusCounter++;
              const body = JSON.parse(init.body as string);
              postCalls.push({ url: '/wt/wt-1/api/statuses', body });
              return jsonResponse({ id: `created-st-${statusCounter}`, ...body });
            }
            return jsonResponse({});
          },
        },
        {
          match: (url) => url.startsWith('/wt/wt-1/api/statuses?projectId='),
          handle: async () => jsonResponse({ items: destStatuses }),
        },
        {
          match: (url, init) => url === '/wt/wt-1/api/epics' && init?.method === 'POST',
          handle: async () => jsonResponse({ id: 'dest-epic-1' }),
        },
        {
          match: (_url, init) => init?.method === 'DELETE',
          handle: async () => jsonResponse({}),
        },
      ]);

      return { postCalls };
    }

    it('uses destination status when single label match found', async () => {
      setupStatusTest(
        [{ id: 'src-st-1', label: 'Review', color: '#f00', position: 0 }],
        [{ id: 'dst-st-1', label: 'review', color: '#0f0', position: 0 }],
      );

      const result = await moveEpicToWorktree({
        epicId: 'root-1',
        destWorktreeName: 'wt-1',
        destProjectId: 'proj-dest',
        statusMap: {},
        agentMap: { 'agent-1': 'dest-agent-1' },
      });

      expect(result.warnings).toEqual([]);

      // Verify the epic POST used the destination status
      const epicPostCall = (global.fetch as jest.Mock).mock.calls.find(
        ([url, init]: [string, RequestInit | undefined]) =>
          url === '/wt/wt-1/api/epics' && init?.method === 'POST',
      );
      const epicBody = JSON.parse(epicPostCall[1].body);
      expect(epicBody.statusId).toBe('dst-st-1');
    });

    it('creates status in destination when no label match (position = max+1)', async () => {
      const { postCalls } = setupStatusTest(
        [{ id: 'src-st-1', label: 'Custom', color: '#abc', position: 0 }],
        [{ id: 'dst-st-1', label: 'Done', color: '#0f0', position: 5 }],
      );

      await moveEpicToWorktree({
        epicId: 'root-1',
        destWorktreeName: 'wt-1',
        destProjectId: 'proj-dest',
        statusMap: {},
        agentMap: {},
      });

      const statusPost = postCalls.find((c) => c.url.includes('/statuses'));
      expect(statusPost).toBeDefined();
      expect(statusPost!.body).toEqual(
        expect.objectContaining({
          label: 'Custom',
          color: '#abc',
          position: 6, // max(5) + 1
          projectId: 'proj-dest',
        }),
      );
    });

    it('warns on ambiguous status match and uses first', async () => {
      setupStatusTest(
        [{ id: 'src-st-1', label: 'Review', color: '#f00', position: 0 }],
        [
          { id: 'dst-st-1', label: 'Review', color: '#0f0', position: 0 },
          { id: 'dst-st-2', label: 'review', color: '#00f', position: 1 },
        ],
      );

      const result = await moveEpicToWorktree({
        epicId: 'root-1',
        destWorktreeName: 'wt-1',
        destProjectId: 'proj-dest',
        statusMap: {},
        agentMap: {},
      });

      expect(result.warnings).toContainEqual(expect.stringContaining('Ambiguous status'));
    });
  });

  // ── Agent mapping ───────────────────────────────────────────────

  describe('agent mapping', () => {
    function setupAgentTest() {
      global.fetch = createRoutingFetch([
        {
          match: (url) => url === '/api/epics/root-1',
          handle: async () => jsonResponse(makeEpic({ agentId: 'agent-x' })),
        },
        {
          match: (url) => url.startsWith('/api/epics?parentId='),
          handle: async () => jsonResponse({ items: [], total: 0, limit: 1000, offset: 0 }),
        },
        {
          match: (url) => url.includes('/comments'),
          handle: async () => jsonResponse({ items: [], total: 0, limit: 1000, offset: 0 }),
        },
        {
          match: (url) => url.startsWith('/api/statuses'),
          handle: async () =>
            jsonResponse({ items: [{ id: 'st-1', label: 'New', color: '#ccc', position: 0 }] }),
        },
        {
          match: (url) => url.startsWith('/wt/wt-1/api/statuses?projectId='),
          handle: async () =>
            jsonResponse({ items: [{ id: 'dst-st-1', label: 'New', color: '#ccc', position: 0 }] }),
        },
        {
          match: (url, init) => url === '/wt/wt-1/api/epics' && init?.method === 'POST',
          handle: async () => jsonResponse({ id: 'dest-1' }),
        },
        {
          match: (_url, init) => init?.method === 'DELETE',
          handle: async () => jsonResponse({}),
        },
      ]);
    }

    it('uses mapped agent ID from agentMap', async () => {
      setupAgentTest();

      await moveEpicToWorktree({
        epicId: 'root-1',
        destWorktreeName: 'wt-1',
        destProjectId: 'proj-dest',
        statusMap: {},
        agentMap: { 'agent-x': 'dest-agent-x' },
      });

      const epicPost = (global.fetch as jest.Mock).mock.calls.find(
        ([url, init]: [string, RequestInit | undefined]) =>
          url === '/wt/wt-1/api/epics' && init?.method === 'POST',
      );
      expect(JSON.parse(epicPost[1].body).agentId).toBe('dest-agent-x');
    });

    it('sets agentId to null when agent not in map', async () => {
      setupAgentTest();

      const result = await moveEpicToWorktree({
        epicId: 'root-1',
        destWorktreeName: 'wt-1',
        destProjectId: 'proj-dest',
        statusMap: {},
        agentMap: {},
      });

      const epicPost = (global.fetch as jest.Mock).mock.calls.find(
        ([url, init]: [string, RequestInit | undefined]) =>
          url === '/wt/wt-1/api/epics' && init?.method === 'POST',
      );
      expect(JSON.parse(epicPost[1].body).agentId).toBeNull();
      expect(result.warnings).toContainEqual(expect.stringContaining('not mapped'));
    });
  });

  // ── Idempotency tag ─────────────────────────────────────────────

  describe('idempotency tag', () => {
    it('adds moved-from:{sourceId} tag to destination parent epic', async () => {
      global.fetch = createRoutingFetch([
        {
          match: (url) => url === '/api/epics/root-1',
          handle: async () => jsonResponse(makeEpic({ tags: ['existing-tag'] })),
        },
        {
          match: (url) => url.startsWith('/api/epics?parentId='),
          handle: async () => jsonResponse({ items: [], total: 0, limit: 1000, offset: 0 }),
        },
        {
          match: (url) => url.includes('/comments'),
          handle: async () => jsonResponse({ items: [], total: 0, limit: 1000, offset: 0 }),
        },
        {
          match: (url) => url.startsWith('/api/statuses'),
          handle: async () =>
            jsonResponse({ items: [{ id: 'st-1', label: 'New', color: '#ccc', position: 0 }] }),
        },
        {
          match: (url) => url.startsWith('/wt/wt-1/api/statuses?projectId='),
          handle: async () =>
            jsonResponse({ items: [{ id: 'dst-st', label: 'New', color: '#ccc', position: 0 }] }),
        },
        {
          match: (url, init) => url === '/wt/wt-1/api/epics' && init?.method === 'POST',
          handle: async () => jsonResponse({ id: 'dest-1' }),
        },
        {
          match: (_url, init) => init?.method === 'DELETE',
          handle: async () => jsonResponse({}),
        },
      ]);

      await moveEpicToWorktree({
        epicId: 'root-1',
        destWorktreeName: 'wt-1',
        destProjectId: 'proj-dest',
        statusMap: {},
        agentMap: {},
      });

      const epicPost = (global.fetch as jest.Mock).mock.calls.find(
        ([url, init]: [string, RequestInit | undefined]) =>
          url === '/wt/wt-1/api/epics' && init?.method === 'POST',
      );
      const body = JSON.parse(epicPost[1].body);
      expect(body.tags).toContain('existing-tag');
      expect(body.tags).toContain('moved-from:root-1');
    });
  });

  // ── Comment copying ─────────────────────────────────────────────

  describe('comment copying', () => {
    it('preserves authorName when copying comments to destination', async () => {
      const commentPosts: Array<{ url: string; body: unknown }> = [];

      global.fetch = createRoutingFetch([
        {
          match: (url) => url === '/api/epics/root-1',
          handle: async () => jsonResponse(makeEpic()),
        },
        {
          match: (url) => url.startsWith('/api/epics?parentId='),
          handle: async () => jsonResponse({ items: [], total: 0, limit: 1000, offset: 0 }),
        },
        {
          match: (url) => url.startsWith('/api/epics/root-1/comments'),
          handle: async () =>
            jsonResponse({
              items: [makeComment('Alice', 'Comment 1'), makeComment('Bob', 'Comment 2')],
              total: 2,
              limit: 1000,
              offset: 0,
            }),
        },
        {
          match: (url) => url.startsWith('/api/statuses'),
          handle: async () =>
            jsonResponse({ items: [{ id: 'st-1', label: 'New', color: '#ccc', position: 0 }] }),
        },
        {
          match: (url) => url.startsWith('/wt/wt-1/api/statuses?projectId='),
          handle: async () =>
            jsonResponse({ items: [{ id: 'dst-st', label: 'New', color: '#ccc', position: 0 }] }),
        },
        {
          match: (url, init) => url === '/wt/wt-1/api/epics' && init?.method === 'POST',
          handle: async () => jsonResponse({ id: 'dest-root' }),
        },
        {
          match: (url, init) =>
            url.startsWith('/wt/wt-1/api/epics/') &&
            url.includes('/comments') &&
            init?.method === 'POST',
          handle: async (url, init) => {
            commentPosts.push({ url, body: JSON.parse(init!.body as string) });
            return jsonResponse({ id: 'c-new' });
          },
        },
        {
          match: (_url, init) => init?.method === 'DELETE',
          handle: async () => jsonResponse({}),
        },
      ]);

      await moveEpicToWorktree({
        epicId: 'root-1',
        destWorktreeName: 'wt-1',
        destProjectId: 'proj-dest',
        statusMap: {},
        agentMap: {},
      });

      expect(commentPosts).toHaveLength(2);
      expect(commentPosts[0].body).toEqual({ authorName: 'Alice', content: 'Comment 1' });
      expect(commentPosts[1].body).toEqual({ authorName: 'Bob', content: 'Comment 2' });
      expect(commentPosts[0].url).toContain('/wt/wt-1/api/epics/dest-root/comments');
    });
  });

  // ── Progress callbacks ──────────────────────────────────────────

  describe('progress callbacks', () => {
    it('fires progress for each phase with correct values', async () => {
      const progressUpdates: MoveProgress[] = [];

      global.fetch = createRoutingFetch([
        {
          match: (url) => url === '/api/epics/root-1',
          handle: async () => jsonResponse(makeEpic()),
        },
        {
          match: (url) => url.startsWith('/api/epics?parentId='),
          handle: async () => jsonResponse({ items: [], total: 0, limit: 1000, offset: 0 }),
        },
        {
          match: (url) => url.includes('/comments') && !url.startsWith('/wt/'),
          handle: async () => jsonResponse({ items: [], total: 0, limit: 1000, offset: 0 }),
        },
        {
          match: (url) => url.startsWith('/api/statuses'),
          handle: async () =>
            jsonResponse({ items: [{ id: 'st-1', label: 'New', color: '#ccc', position: 0 }] }),
        },
        {
          match: (url) => url.startsWith('/wt/wt-1/api/statuses?projectId='),
          handle: async () =>
            jsonResponse({ items: [{ id: 'dst-st', label: 'New', color: '#ccc', position: 0 }] }),
        },
        {
          match: (url, init) => url === '/wt/wt-1/api/epics' && init?.method === 'POST',
          handle: async () => jsonResponse({ id: 'dest-1' }),
        },
        {
          match: (_url, init) => init?.method === 'DELETE',
          handle: async () => jsonResponse({}),
        },
      ]);

      await moveEpicToWorktree({
        epicId: 'root-1',
        destWorktreeName: 'wt-1',
        destProjectId: 'proj-dest',
        statusMap: {},
        agentMap: {},
        onProgress: (p) => progressUpdates.push({ ...p }),
      });

      const phases = progressUpdates.map((p) => p.phase);
      expect(phases).toContain('extracting');
      expect(phases).toContain('mapping');
      expect(phases).toContain('creating');
      expect(phases).toContain('deleting-source');
    });
  });

  // ── Destination API prefix ──────────────────────────────────────

  describe('destination API calls use /wt/ prefix', () => {
    it('all destination calls go through /wt/{destName}/api/', async () => {
      global.fetch = createRoutingFetch([
        {
          match: (url) => url === '/api/epics/root-1',
          handle: async () => jsonResponse(makeEpic()),
        },
        {
          match: (url) => url.startsWith('/api/epics?parentId='),
          handle: async () => jsonResponse({ items: [], total: 0, limit: 1000, offset: 0 }),
        },
        {
          match: (url) => url.includes('/comments') && !url.startsWith('/wt/'),
          handle: async () => jsonResponse({ items: [], total: 0, limit: 1000, offset: 0 }),
        },
        {
          match: (url) => url.startsWith('/api/statuses'),
          handle: async () =>
            jsonResponse({ items: [{ id: 'st-1', label: 'New', color: '#ccc', position: 0 }] }),
        },
        {
          match: (url) => url.startsWith('/wt/feat/api/statuses?projectId='),
          handle: async () =>
            jsonResponse({ items: [{ id: 'dst-st', label: 'New', color: '#ccc', position: 0 }] }),
        },
        {
          match: (url, init) => url === '/wt/feat/api/epics' && init?.method === 'POST',
          handle: async () => jsonResponse({ id: 'dest-1' }),
        },
        {
          match: (_url, init) => init?.method === 'DELETE',
          handle: async () => jsonResponse({}),
        },
      ]);

      await moveEpicToWorktree({
        epicId: 'root-1',
        destWorktreeName: 'feat',
        destProjectId: 'proj-dest',
        statusMap: {},
        agentMap: {},
      });

      const calls = (global.fetch as jest.Mock).mock.calls.map(([url]: [string]) => url);
      const destCalls = calls.filter((url: string) => url.includes('/wt/feat/api/'));
      // Should have at least: dest statuses GET, epic POST
      expect(destCalls.length).toBeGreaterThanOrEqual(2);
      // All dest calls must use the /wt/ prefix
      for (const url of destCalls) {
        expect(url).toMatch(/^\/wt\/feat\/api\//);
      }
    });
  });

  // ── Rollback on partial create failure ──────────────────────────

  describe('rollback on partial create failure', () => {
    it('deletes created epics in reverse order and created statuses', async () => {
      const deletedUrls: string[] = [];
      let createCallCount = 0;

      global.fetch = createRoutingFetch([
        {
          match: (url) => url === '/api/epics/root-1',
          handle: async () => jsonResponse(makeEpic({ id: 'root-1', statusId: 'src-st-1' })),
        },
        {
          match: (url) => url.startsWith('/api/epics?parentId=root-1'),
          handle: async () =>
            jsonResponse({
              items: [makeEpic({ id: 'child-1', parentId: 'root-1', statusId: 'src-st-1' })],
              total: 1,
              limit: 1000,
              offset: 0,
            }),
        },
        {
          match: (url) => url.startsWith('/api/epics?parentId=child-1'),
          handle: async () => jsonResponse({ items: [], total: 0, limit: 1000, offset: 0 }),
        },
        {
          match: (url) => url.includes('/comments') && !url.startsWith('/wt/'),
          handle: async () => jsonResponse({ items: [], total: 0, limit: 1000, offset: 0 }),
        },
        {
          match: (url) => url.startsWith('/api/statuses'),
          handle: async () =>
            jsonResponse({
              items: [{ id: 'src-st-1', label: 'Custom', color: '#abc', position: 0 }],
            }),
        },
        // Dest has no matching status, so one will be created
        {
          match: (url) => url.startsWith('/wt/wt-1/api/statuses?projectId='),
          handle: async () => jsonResponse({ items: [] }),
        },
        // Status creation in dest
        {
          match: (url, init) =>
            url.startsWith('/wt/wt-1/api/statuses') &&
            !url.includes('?') &&
            init?.method === 'POST',
          handle: async () =>
            jsonResponse({ id: 'created-status-1', label: 'Custom', color: '#abc', position: 0 }),
        },
        // Epic creation: succeed first, fail on second
        {
          match: (url, init) => url === '/wt/wt-1/api/epics' && init?.method === 'POST',
          handle: async () => {
            createCallCount++;
            if (createCallCount === 1) {
              return jsonResponse({ id: 'dest-root' });
            }
            // Fail on second create (child epic)
            return errorResponse(500, 'Server Error');
          },
        },
        // DELETE (rollback)
        {
          match: (_url, init) => init?.method === 'DELETE',
          handle: async (url) => {
            deletedUrls.push(url);
            return jsonResponse({});
          },
        },
      ]);

      await expect(
        moveEpicToWorktree({
          epicId: 'root-1',
          destWorktreeName: 'wt-1',
          destProjectId: 'proj-dest',
          statusMap: {},
          agentMap: {},
        }),
      ).rejects.toThrow('Move failed during creation');

      // Should have rolled back the created epic
      expect(deletedUrls).toContain('/wt/wt-1/api/epics/dest-root');
      // Should have rolled back the created status
      expect(deletedUrls).toContain('/wt/wt-1/api/statuses/created-status-1');
    });
  });

  // ── Source delete failure returns warning ────────────────────────

  describe('source delete failure', () => {
    it('returns warning instead of throwing when source delete fails', async () => {
      global.fetch = createRoutingFetch([
        // Source DELETE fails — must be before GET to match first
        {
          match: (url, init) => url === '/api/epics/root-1' && init?.method === 'DELETE',
          handle: async () => errorResponse(500, 'Cannot delete'),
        },
        {
          match: (url, init) => url === '/api/epics/root-1' && init?.method !== 'DELETE',
          handle: async () => jsonResponse(makeEpic()),
        },
        {
          match: (url) => url.startsWith('/api/epics?parentId='),
          handle: async () => jsonResponse({ items: [], total: 0, limit: 1000, offset: 0 }),
        },
        {
          match: (url) => url.includes('/comments') && !url.startsWith('/wt/'),
          handle: async () => jsonResponse({ items: [], total: 0, limit: 1000, offset: 0 }),
        },
        {
          match: (url) => url.startsWith('/api/statuses'),
          handle: async () =>
            jsonResponse({ items: [{ id: 'st-1', label: 'New', color: '#ccc', position: 0 }] }),
        },
        {
          match: (url) => url.startsWith('/wt/wt-1/api/statuses?projectId='),
          handle: async () =>
            jsonResponse({ items: [{ id: 'dst-st', label: 'New', color: '#ccc', position: 0 }] }),
        },
        {
          match: (url, init) => url === '/wt/wt-1/api/epics' && init?.method === 'POST',
          handle: async () => jsonResponse({ id: 'dest-root' }),
        },
      ]);

      const result = await moveEpicToWorktree({
        epicId: 'root-1',
        destWorktreeName: 'wt-1',
        destProjectId: 'proj-dest',
        statusMap: {},
        agentMap: {},
      });

      // Should NOT throw — returns a result with warning
      expect(result.destEpicId).toBe('dest-root');
      expect(result.warnings).toContainEqual(expect.stringContaining('not removed from source'));
      expect(result.warnings).toContainEqual(expect.stringContaining('moved-from:root-1'));
    });
  });

  // ── Pagination ──────────────────────────────────────────────────

  describe('pagination', () => {
    it('fetches multiple pages of children when hitting page limit', async () => {
      let childrenFetchCount = 0;

      global.fetch = createRoutingFetch([
        {
          match: (url) => url === '/api/epics/root-1',
          handle: async () => jsonResponse(makeEpic()),
        },
        {
          match: (url) => url.startsWith('/api/epics?parentId=root-1'),
          handle: async (url) => {
            childrenFetchCount++;
            const offset = parseInt(new URL(`http://x${url}`).searchParams.get('offset') ?? '0');
            if (offset === 0) {
              // Return full page (1000 items) to trigger next page fetch
              const items = Array.from({ length: 1000 }, (_, i) =>
                makeEpic({ id: `child-${i}`, parentId: 'root-1', title: `Child ${i}` }),
              );
              return jsonResponse({ items, total: 1001, limit: 1000, offset: 0 });
            }
            // Second page: 1 remaining item
            return jsonResponse({
              items: [makeEpic({ id: 'child-1000', parentId: 'root-1', title: 'Child 1000' })],
              total: 1001,
              limit: 1000,
              offset: 1000,
            });
          },
        },
        // All grandchildren: empty
        {
          match: (url) => url.startsWith('/api/epics?parentId=child-'),
          handle: async () => jsonResponse({ items: [], total: 0, limit: 1000, offset: 0 }),
        },
        {
          match: (url) => url.includes('/comments'),
          handle: async () => jsonResponse({ items: [], total: 0, limit: 1000, offset: 0 }),
        },
        {
          match: (url) => url.startsWith('/api/statuses'),
          handle: async () =>
            jsonResponse({ items: [{ id: 'st-1', label: 'New', color: '#ccc', position: 0 }] }),
        },
        {
          match: (url) => url.startsWith('/wt/wt-1/api/statuses?projectId='),
          handle: async () =>
            jsonResponse({ items: [{ id: 'dst-st', label: 'New', color: '#ccc', position: 0 }] }),
        },
        {
          match: (url, init) => url === '/wt/wt-1/api/epics' && init?.method === 'POST',
          handle: async () => jsonResponse({ id: `dest-${Date.now()}` }),
        },
        {
          match: (_url, init) => init?.method === 'DELETE',
          handle: async () => jsonResponse({}),
        },
      ]);

      await moveEpicToWorktree({
        epicId: 'root-1',
        destWorktreeName: 'wt-1',
        destProjectId: 'proj-dest',
        statusMap: {},
        agentMap: {},
      });

      // Should have made 2 fetch calls for root children (page 1 + page 2)
      expect(childrenFetchCount).toBe(2);
    });
  });

  // ── Pre-resolved status map from dialog ─────────────────────────

  describe('pre-resolved status map', () => {
    it('uses pre-resolved statusMap without re-resolving', async () => {
      global.fetch = createRoutingFetch([
        {
          match: (url) => url === '/api/epics/root-1',
          handle: async () => jsonResponse(makeEpic({ statusId: 'src-st-1' })),
        },
        {
          match: (url) => url.startsWith('/api/epics?parentId='),
          handle: async () => jsonResponse({ items: [], total: 0, limit: 1000, offset: 0 }),
        },
        {
          match: (url) => url.includes('/comments') && !url.startsWith('/wt/'),
          handle: async () => jsonResponse({ items: [], total: 0, limit: 1000, offset: 0 }),
        },
        {
          match: (url) => url.startsWith('/api/statuses'),
          handle: async () =>
            jsonResponse({ items: [{ id: 'src-st-1', label: 'X', color: '#000', position: 0 }] }),
        },
        {
          match: (url) => url.startsWith('/wt/wt-1/api/statuses?projectId='),
          handle: async () => jsonResponse({ items: [] }),
        },
        {
          match: (url, init) => url === '/wt/wt-1/api/epics' && init?.method === 'POST',
          handle: async () => jsonResponse({ id: 'dest-1' }),
        },
        {
          match: (_url, init) => init?.method === 'DELETE',
          handle: async () => jsonResponse({}),
        },
      ]);

      await moveEpicToWorktree({
        epicId: 'root-1',
        destWorktreeName: 'wt-1',
        destProjectId: 'proj-dest',
        statusMap: { 'src-st-1': 'pre-resolved-dst-st' },
        agentMap: {},
      });

      // Verify the pre-resolved status was used (no status creation POST)
      const statusPosts = (global.fetch as jest.Mock).mock.calls.filter(
        ([url, init]: [string, RequestInit | undefined]) =>
          url.includes('/wt/wt-1/api/statuses') && !url.includes('?') && init?.method === 'POST',
      );
      expect(statusPosts).toHaveLength(0);

      // Verify the epic used the pre-resolved status
      const epicPost = (global.fetch as jest.Mock).mock.calls.find(
        ([url, init]: [string, RequestInit | undefined]) =>
          url === '/wt/wt-1/api/epics' && init?.method === 'POST',
      );
      expect(JSON.parse(epicPost[1].body).statusId).toBe('pre-resolved-dst-st');
    });
  });
});
