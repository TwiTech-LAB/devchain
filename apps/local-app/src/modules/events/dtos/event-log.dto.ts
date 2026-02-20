export type EventHandlerStatus = 'success' | 'failure';

export interface EventHandlerLogDto {
  id: string;
  eventId: string;
  handler: string;
  status: EventHandlerStatus;
  detail: unknown;
  startedAt: string;
  endedAt: string | null;
}

export interface EventLogDto {
  id: string;
  name: string;
  payload: unknown;
  requestId: string | null;
  publishedAt: string;
  handlers: EventHandlerLogDto[];
}

export interface EventLogListFilters {
  name?: string;
  ownerProjectId?: string;
  handler?: string;
  status?: EventHandlerStatus;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface EventLogListResult {
  items: EventLogDto[];
  total: number;
  limit: number;
  offset: number;
}
