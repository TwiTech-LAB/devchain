# Frontend Code Review Findings

## 1. Overall Summary

- UI components currently handle significant business logic (queries, optimistic updates, validation). That coupling makes flows hard to reason about and violates the separation-of-concerns goals we have for state management.
- TypeScript typing is mostly strict, but a few patterns—`NodeJS.Timeout` in browser code, mutating `fetch` payloads without typed helpers—reduce type safety and make future refactors riskier.
- Layout, Toast, and design-system usage are consistent and accessible, yet the router/navigation map has mismatches that lead to broken UX.

## 2. Critical Issues

| Location | Issue |
| --- | --- |
| `src/ui/components/Terminal.tsx:98-133` | Terminal resubscribe logic always replays from sequence `0`, so reconnects drop buffered output. |
| `src/ui/components/Layout.tsx:34-43` | Sidebar links to `/records`, but the route is missing—users hit 404 every time. |
| `src/ui/components/Terminal.tsx:223-226` | “Open in new tab” points to `/terminal/:id`, another undefined route. |

## 3. File-by-File Findings

### `src/ui/components/Layout.tsx`

1. **Broken navigation link (High · Component Design)**  
   Sidebar exposes `/records`, but `App.tsx` never registers that route. Users always land on the 404 screen. Hide the link until the page exists or wire up the route.

### `src/ui/components/Terminal.tsx`

1. **Replay is broken after reconnect (Critical · State Management)**  
   `lastSequence` lives in component state while the effect only depends on `sessionId`. When the socket reconnects, the closure still sees `0`, so the server never resends the missed backlog. Persist the value in a `useRef` (or include it in the effect deps and reinitialize cleanly).

2. **Hardcoded API origin (High · Framework Best Practices)**  
   The socket client targets `http://127.0.0.1:3000`, which fails for remote deployments, proxies, or HTTPS. Use configuration (`VITE_API_BASE_URL` or `window.location.origin`) instead.

3. **Broken “open in new tab” (High · Component Design)**  
   Button opens `/terminal/:id`, but the SPA has no such route. Either remove the button or link to the backend console endpoint.

### `src/ui/pages/BoardPage.tsx`

1. **Node-only timeout type (Medium · Type Safety)**  
   `useRef<NodeJS.Timeout>` relies on Node types. In the browser build this collapses to `any`. Replace with `ReturnType<typeof setTimeout>`.

2. **Cache mutation (High · State Management)**  
   `sort` mutates the array returned from React Query, corrupting cache references. Clone before sorting.

3. **Component owns too much logic (Medium · Component Design)**  
   ~800 lines mix data fetching, optimistic updates, drag-and-drop, and all rendering, making reuse/testing painful. Extract hooks (e.g., `useEpicsBoard`) and smaller presentational components.

### `src/ui/pages/StatusesPage.tsx`

1. **Cache mutation (High · State Management)**  
   Same in-place `sort` mutation against React Query cache. Clone first.

2. **Optimistic update drops metadata (Medium · State Management)**  
   `setQueryData` overwrites the cache with `{ items }`, discarding accompanying fields like `total`. Merge with the existing cache object instead of replacing it outright.

3. **Node-only timeout type (Medium · Type Safety)**  
   Replace `NodeJS.Timeout` with `ReturnType<typeof setTimeout>`.

### `src/ui/pages/AgentsPage.tsx`

1. **Optimistic updates target the wrong key when switching projects (High · State Management)**  
   Mutations cancel/update `['agents', selectedProjectId]`, but `selectedProjectId` is read from component state. If the user switches projects while a mutation is pending, the wrong cache entry is touched. Use the project ID from the mutation variables instead.

## 4. Positive Observations

- Consistent use of ShadCN components keeps forms accessible with labels and focus states baked in.
- React Query optimistic updates with rollbacks show good attention to perceived performance.
- Loading, empty, and error states are thoughtfully handled across pages, keeping the UI communicative during async work.

## 5. Recommendations

1. Fix the terminal reconnection/replay logic and remove hard-coded URLs—these are blocking issues for session observability.
2. Align navigation with registered routes so users stop hitting dead pages.
3. Refactor `BoardPage` and `StatusesPage` to avoid mutating React Query cache objects and to adopt browser-safe timeout typings.
4. Extract shared mutation logic into dedicated hooks/stores to enforce a clean separation between data orchestration and presentation layers.
5. Add typed response helpers (`ApiListResponse<T>`, etc.) so optimistic cache writes don’t rely on loose `any` spreads.
