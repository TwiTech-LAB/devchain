/**
 * Subscribers API functions
 * Provides centralized API layer for subscriber management.
 */

// ============================================
// TYPES
// ============================================

export interface ActionInput {
  source: 'event_field' | 'custom';
  eventField?: string;
  customValue?: string;
}

export interface EventFilter {
  field: string;
  operator: 'equals' | 'contains' | 'regex';
  value: string;
}

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
export async function fetchSubscribableEvents(): Promise<SubscribableEventDefinition[]> {
  const response = await fetch('/api/subscribers/events');
  if (!response.ok) {
    throw new Error('Failed to fetch subscribable events');
  }
  const data = await response.json();
  return data.events;
}

/**
 * Fetch all subscribers for a project.
 */
export async function fetchSubscribers(projectId: string): Promise<Subscriber[]> {
  const params = new URLSearchParams({ projectId });
  const response = await fetch(`/api/subscribers?${params.toString()}`);
  if (!response.ok) {
    throw new Error('Failed to fetch subscribers');
  }
  return response.json();
}

/**
 * Fetch a single subscriber by ID.
 */
export async function fetchSubscriber(id: string): Promise<Subscriber> {
  const response = await fetch(`/api/subscribers/${id}`);
  if (!response.ok) {
    throw new Error('Failed to fetch subscriber');
  }
  return response.json();
}

/**
 * Create a new subscriber.
 */
export async function createSubscriber(data: CreateSubscriberData): Promise<Subscriber> {
  const response = await fetch('/api/subscribers', {
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
  id: string,
  data: UpdateSubscriberData,
): Promise<Subscriber> {
  const response = await fetch(`/api/subscribers/${id}`, {
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
export async function deleteSubscriber(id: string): Promise<void> {
  const response = await fetch(`/api/subscribers/${id}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error('Failed to delete subscriber');
  }
}

/**
 * Toggle a subscriber's enabled status.
 */
export async function toggleSubscriber(id: string, enabled: boolean): Promise<Subscriber> {
  const response = await fetch(`/api/subscribers/${id}/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) {
    throw new Error('Failed to toggle subscriber');
  }
  return response.json();
}
