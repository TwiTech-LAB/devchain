/**
 * Subscribers API functions
 * Provides centralized API layer for subscriber management.
 */
import type { FetchFn } from '@/ui/lib/api-transport';

// ============================================
// TYPES
// ============================================

export interface ActionInput {
  source: 'event_field' | 'custom';
  eventField?: string;
  customValue?: string;
}

export interface EventFilterCondition {
  field: string;
  operator: 'equals' | 'contains' | 'regex' | 'is_null' | 'is_not_null';
  value: string;
}

export interface EventFilterGroup {
  combinator: 'and' | 'or';
  filters: [EventFilterCondition, ...EventFilterCondition[]];
}

export type EventFilter = EventFilterCondition | EventFilterGroup;

export interface Subscriber {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  eventName: string;
  eventFilter: EventFilter | null;
  actionType: string;
  actionInputs: Record<string, ActionInput>;
  delayMs: number;
  cooldownMs: number;
  retryOnError: boolean;
  // Grouping & ordering
  groupName: string | null;
  position: number;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSubscriberData {
  projectId: string;
  name: string;
  description?: string;
  enabled?: boolean;
  eventName: string;
  eventFilter?: EventFilter | null;
  actionType: string;
  actionInputs: Record<string, ActionInput>;
  delayMs?: number;
  cooldownMs?: number;
  retryOnError?: boolean;
  // Grouping & ordering
  groupName?: string | null;
  position?: number;
  priority?: number;
}

export interface UpdateSubscriberData {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  eventName?: string;
  eventFilter?: EventFilter | null;
  actionType?: string;
  actionInputs?: Record<string, ActionInput>;
  delayMs?: number;
  cooldownMs?: number;
  retryOnError?: boolean;
  // Grouping & ordering
  groupName?: string | null;
  position?: number;
  priority?: number;
}

export interface EventFieldDefinition {
  field: string;
  label: string;
  type: 'string' | 'number' | 'boolean';
  nullable?: boolean;
}

export interface SubscribableEventDefinition {
  name: string;
  label: string;
  description: string;
  category: 'terminal' | 'session' | 'epic' | 'chat';
  fields: EventFieldDefinition[];
}

// ============================================
// API FUNCTIONS
// ============================================

/**
 * Fetch all subscribable events with their field definitions.
 */
export async function fetchSubscribableEvents(
  fetchFn: FetchFn,
): Promise<SubscribableEventDefinition[]> {
  const response = await fetchFn('/api/subscribers/events');
  if (!response.ok) {
    throw new Error('Failed to fetch subscribable events');
  }
  const data = await response.json();
  return data.events;
}

/**
 * Fetch all subscribers for a project.
 */
export async function fetchSubscribers(fetchFn: FetchFn, projectId: string): Promise<Subscriber[]> {
  const params = new URLSearchParams({ projectId });
  const response = await fetchFn(`/api/subscribers?${params.toString()}`);
  if (!response.ok) {
    throw new Error('Failed to fetch subscribers');
  }
  return response.json();
}

/**
 * Fetch a single subscriber by ID.
 */
export async function fetchSubscriber(fetchFn: FetchFn, id: string): Promise<Subscriber> {
  const response = await fetchFn(`/api/subscribers/${id}`);
  if (!response.ok) {
    throw new Error('Failed to fetch subscriber');
  }
  return response.json();
}

/**
 * Create a new subscriber.
 */
export async function createSubscriber(
  fetchFn: FetchFn,
  data: CreateSubscriberData,
): Promise<Subscriber> {
  const response = await fetchFn('/api/subscribers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Failed to create subscriber' }));
    throw new Error(error.message || 'Failed to create subscriber');
  }
  return response.json();
}

/**
 * Update an existing subscriber.
 */
export async function updateSubscriber(
  fetchFn: FetchFn,
  id: string,
  data: UpdateSubscriberData,
): Promise<Subscriber> {
  const response = await fetchFn(`/api/subscribers/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Failed to update subscriber' }));
    throw new Error(error.message || 'Failed to update subscriber');
  }
  return response.json();
}

/**
 * Delete a subscriber.
 */
export async function deleteSubscriber(fetchFn: FetchFn, id: string): Promise<void> {
  const response = await fetchFn(`/api/subscribers/${id}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error('Failed to delete subscriber');
  }
}

/**
 * Toggle a subscriber's enabled status.
 */
export async function toggleSubscriber(
  fetchFn: FetchFn,
  id: string,
  enabled: boolean,
): Promise<Subscriber> {
  const response = await fetchFn(`/api/subscribers/${id}/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) {
    throw new Error('Failed to toggle subscriber');
  }
  return response.json();
}
