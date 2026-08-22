/**
 * Catalog of web-client-reacted *direct* (non-registry) broadcasts.
 *
 * Registry-driven broadcasts (EventEmitter2 → CatalogBroadcaster) no longer live
 * here: their client-reaction contract is co-located on each `broadcast-registry.ts`
 * entry via `clientReaction`, and the compiler now forces it (see the alignment
 * spec, which derives registry coverage from the registry itself).
 *
 * This list mirrors ONLY the direct broadcasts (emitted outside the registry's
 * projectBroadcast path) that the web client already reacts to. It is **NOT** an
 * exhaustive inventory of every websocket frame the gateways emit — terminal/MCP/
 * session frames were never tracked here and stay out (e.g. `terminal.gateway.ts`
 * around L550-552).
 *
 * Each entry declares: topic pattern, type, kind, and the hook/component that owns it.
 */
export interface RegistryCatalogEntry {
  topicPattern: string;
  type: string;
  kind: 'invalidate' | 'no-op' | 'custom-handler';
  owner: string;
}

export const nonRegistryBroadcastCatalog: RegistryCatalogEntry[] = [
  // ── Cloud ──
  { topicPattern: 'cloud', type: 'connected', kind: 'invalidate', owner: 'useCloudConnection' },
  { topicPattern: 'cloud', type: 'disconnected', kind: 'invalidate', owner: 'useCloudConnection' },
  {
    topicPattern: 'cloud',
    type: 'egress_disconnected',
    kind: 'invalidate',
    owner: 'useCloudConnection',
  },

  // ── Events stream ──
  { topicPattern: 'events/logs', type: 'event_created', kind: 'invalidate', owner: 'EventsPage' },
  {
    topicPattern: 'events/logs',
    type: 'handler_recorded',
    kind: 'invalidate',
    owner: 'EventsPage',
  },

  // ── Message activity ──
  {
    topicPattern: 'messages/activity',
    type: 'enqueued',
    kind: 'invalidate',
    owner: 'MessageActivityList',
  },
  {
    topicPattern: 'messages/activity',
    type: 'delivered',
    kind: 'invalidate',
    owner: 'MessageActivityList',
  },
  {
    topicPattern: 'messages/activity',
    type: 'unconfirmed',
    kind: 'invalidate',
    owner: 'MessageActivityList',
  },
  {
    topicPattern: 'messages/activity',
    type: 'failed',
    kind: 'invalidate',
    owner: 'MessageActivityList',
  },

  // ── Message pools ──
  {
    topicPattern: 'messages/pools',
    type: 'updated',
    kind: 'invalidate',
    owner: 'useMessagePools',
  },

  // ── System ──
  { topicPattern: 'system', type: 'ping', kind: 'custom-handler', owner: 'socket.ts' },
];
