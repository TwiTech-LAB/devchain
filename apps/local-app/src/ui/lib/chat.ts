export interface Thread {
  id: string;
  projectId: string;
  title: string | null;
  isGroup: boolean;
  createdByType: 'user' | 'agent' | 'system';
  createdByUserId: string | null;
  createdByAgentId: string | null;
  members?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ThreadsListResponse {
  items: Thread[];
  total: number;
  limit: number;
  offset: number;
}

export interface CreateGroupThreadRequest {
  projectId: string;
  agentIds: string[];
  title?: string;
}

export interface CreateDirectThreadRequest {
  projectId: string;
  agentId: string;
}

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const defaultFetch: FetchFn = (input, init) => {
  if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
    return window.fetch.call(window, input as RequestInfo, init);
  }
  return Promise.reject(new Error('fetch not available'));
};

export async function fetchThreads(
  projectId: string,
  createdByType?: 'user' | 'agent' | 'system',
  limit = 50,
  offset = 0,
  fetchFn: FetchFn = defaultFetch,
): Promise<ThreadsListResponse> {
  const params = new URLSearchParams({
    projectId,
    limit: String(limit),
    offset: String(offset),
  });

  if (createdByType) {
    params.append('createdByType', createdByType);
  }

  const response = await fetchFn(`/api/chat/threads?${params.toString()}`);
  if (!response.ok) {
    throw new Error('Failed to fetch threads');
  }
  return response.json();
}

export async function fetchThread(
  threadId: string,
  projectId: string,
  fetchFn: FetchFn = defaultFetch,
): Promise<Thread> {
  const params = new URLSearchParams({ projectId });
  const response = await fetchFn(`/api/chat/threads/${threadId}?${params.toString()}`);
  if (!response.ok) {
    throw new Error('Failed to fetch thread');
  }
  return response.json();
}

export async function createGroupThread(
  request: CreateGroupThreadRequest,
  fetchFn: FetchFn = defaultFetch,
): Promise<Thread> {
  const response = await fetchFn('/api/chat/threads/group', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error('Failed to create group thread');
  }
  return response.json();
}

export async function createDirectThread(
  request: CreateDirectThreadRequest,
  fetchFn: FetchFn = defaultFetch,
): Promise<Thread> {
  const response = await fetchFn('/api/chat/threads/direct', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error('Failed to create direct thread');
  }
  return response.json();
}

export interface Message {
  id: string;
  threadId: string;
  authorType: 'user' | 'agent' | 'system';
  authorAgentId: string | null;
  content: string;
  targets?: string[];
  createdAt: string;
}

export interface MessagesListResponse {
  items: Message[];
  total: number;
  limit: number;
  offset: number;
}

export interface CreateMessageRequest {
  content: string;
  authorType: 'user' | 'agent';
  projectId: string;
  authorAgentId?: string;
  targets?: string[];
}

export async function fetchMessages(
  threadId: string,
  projectId: string,
  since?: string,
  limit = 50,
  offset = 0,
  fetchFn: FetchFn = defaultFetch,
): Promise<MessagesListResponse> {
  const params = new URLSearchParams({
    projectId,
    limit: String(limit),
    offset: String(offset),
  });

  if (since) {
    params.append('since', since);
  }

  const response = await fetchFn(`/api/chat/threads/${threadId}/messages?${params.toString()}`);
  if (!response.ok) {
    throw new Error('Failed to fetch messages');
  }
  return response.json();
}

export async function createMessage(
  threadId: string,
  request: CreateMessageRequest,
  fetchFn: FetchFn = defaultFetch,
): Promise<Message> {
  const response = await fetchFn(`/api/chat/threads/${threadId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error('Failed to create message');
  }
  return response.json();
}

export interface InviteMembersRequest {
  agentIds: string[];
  projectId: string;
  inviterName?: string;
}

export async function inviteMembers(
  threadId: string,
  request: InviteMembersRequest,
  fetchFn: FetchFn = defaultFetch,
): Promise<Thread> {
  const response = await fetchFn(`/api/chat/threads/${threadId}/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error('Failed to invite members');
  }

  return response.json();
}

/**
 * Parse @mentions from message content
 * Returns array of agent IDs mentioned
 */
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function parseMentions(
  content: string,
  agents: Array<{ id: string; name: string }>,
): string[] {
  const mentionedIds: string[] = [];
  const normalizedContent = content.toLowerCase();

  for (const agent of agents) {
    const normalizedName = agent.name.trim().toLowerCase();
    if (!normalizedName) {
      continue;
    }

    const handle = `@${escapeRegExp(normalizedName)}`;
    const pattern = new RegExp(`(^|[^\\w@])${handle}(?=$|[^\\w])`, 'g');

    if (pattern.test(normalizedContent) && !mentionedIds.includes(agent.id)) {
      mentionedIds.push(agent.id);
    }
  }

  return mentionedIds;
}

export interface ChatSettingsResponse {
  invite_template: string;
  is_default: boolean;
}

export async function fetchChatSettings(
  projectId: string,
  fetchFn: FetchFn = defaultFetch,
): Promise<ChatSettingsResponse> {
  const params = new URLSearchParams({ projectId });
  const response = await fetchFn(`/api/chat/settings?${params.toString()}`);

  if (!response.ok) {
    throw new Error('Failed to fetch chat settings');
  }

  return response.json();
}

export interface UpdateChatSettingsRequest {
  projectId: string;
  invite_template: string;
}

export async function updateChatSettings(
  request: UpdateChatSettingsRequest,
  fetchFn: FetchFn = defaultFetch,
): Promise<ChatSettingsResponse> {
  const response = await fetchFn('/api/chat/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error('Failed to update chat settings');
  }

  return response.json();
}

export interface ClearHistoryRequest {
  announce?: boolean;
}

export async function clearHistory(
  threadId: string,
  request: ClearHistoryRequest = {},
  fetchFn: FetchFn = defaultFetch,
): Promise<Thread> {
  const response = await fetchFn(`/api/chat/threads/${threadId}/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error('Failed to clear history');
  }

  return response.json();
}

export interface PurgeHistoryRequest {
  before?: string;
  announce?: boolean;
}

export async function purgeHistory(
  threadId: string,
  request: PurgeHistoryRequest = {},
  fetchFn: FetchFn = defaultFetch,
): Promise<Thread> {
  const response = await fetchFn(`/api/chat/threads/${threadId}/purge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error('Failed to purge history');
  }

  return response.json();
}
