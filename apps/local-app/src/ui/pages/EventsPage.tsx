import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WsEnvelope } from '@/ui/lib/socket';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import type { Socket } from 'socket.io-client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { Button } from '@/ui/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui/components/ui/table';
import { Badge } from '@/ui/components/ui/badge';
import { ScrollArea } from '@/ui/components/ui/scroll-area';
import { cn } from '@/ui/lib/utils';
import { RefreshCw, Clock } from 'lucide-react';

interface EventHandlerLog {
  id: string;
  eventId: string;
  handler: string;
  status: 'success' | 'failure';
  detail: unknown;
  startedAt: string;
  endedAt: string | null;
}

interface EventLog {
  id: string;
  name: string;
  payload: unknown;
  requestId: string | null;
  publishedAt: string;
  handlers: EventHandlerLog[];
}

interface EventsListResult {
  items: EventLog[];
  total: number;
  limit: number;
  offset: number;
}

interface FetchEventsParams {
  name?: string;
  handler?: string;
  status?: 'success' | 'failure';
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

// WsEnvelope now imported from shared lib

const DEFAULT_FILTERS = {
  name: '',
  handler: '',
  status: 'all' as 'all' | 'success' | 'failure',
  timeRange: '1h' as '1h' | '24h' | '7d' | '30d' | 'all',
};

const TIME_RANGE_OPTIONS = [
  { label: 'Last hour', value: '1h' },
  { label: 'Last 24 hours', value: '24h' },
  { label: 'Last 7 days', value: '7d' },
  { label: 'Last 30 days', value: '30d' },
  { label: 'All time', value: 'all' },
] as const;

async function fetchEvents(params: FetchEventsParams): Promise<EventsListResult> {
  const search = new URLSearchParams();

  if (params.name) search.set('name', params.name);
  if (params.handler) search.set('handler', params.handler);
  if (params.status) search.set('status', params.status);
  if (params.from) search.set('from', params.from);
  if (params.to) search.set('to', params.to);
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.offset !== undefined) search.set('offset', String(params.offset));

  const res = await fetch(`/api/events?${search.toString()}`);
  if (!res.ok) {
    throw new Error('Failed to fetch events');
  }
  return res.json();
}

function computeTimeRange(range: typeof DEFAULT_FILTERS.timeRange): { from?: string; to?: string } {
  if (range === 'all') {
    return {};
  }

  const now = new Date();
  let from: Date | undefined;

  switch (range) {
    case '1h':
      from = new Date(now.getTime() - 60 * 60 * 1000);
      break;
    case '24h':
      from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      break;
    case '7d':
      from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case '30d':
      from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    default:
      from = undefined;
      break;
  }

  return from
    ? {
        from: from.toISOString(),
        to: now.toISOString(),
      }
    : {};
}

function formatJson(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return value;
    }
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summarizeHandlers(handlers: EventHandlerLog[]): {
  total: number;
  success: number;
  failure: number;
} {
  return handlers.reduce(
    (acc, handler) => {
      acc.total += 1;
      if (handler.status === 'success') {
        acc.success += 1;
      } else {
        acc.failure += 1;
      }
      return acc;
    },
    { total: 0, success: 0, failure: 0 },
  );
}

export function EventsPage() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [pagination, setPagination] = useState({ limit: 50, offset: 0 });
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  useEffect(() => {
    setPagination((prev) => (prev.offset === 0 ? prev : { ...prev, offset: 0 }));
  }, [filters.name, filters.handler, filters.status, filters.timeRange]);

  const handleEnvelope = useCallback(
    (envelope: WsEnvelope) => {
      if (!envelope) return;
      const { topic, type } = envelope;
      if (topic === 'events/logs' && (type === 'event_created' || type === 'handler_recorded')) {
        queryClient.invalidateQueries({ queryKey: ['eventLogs'] });
      }
    },
    [queryClient],
  );

  // Subscribe via shared socket; keep a semantic subscribe on connect
  const eventsSocketRef = useRef<Socket | null>(null);
  const eventsSocket = useAppSocket(
    {
      connect: () => {
        eventsSocketRef.current?.emit('events:subscribe');
      },
      message: handleEnvelope,
    },
    [handleEnvelope],
  );
  eventsSocketRef.current = eventsSocket;

  const timeFilters = useMemo(() => computeTimeRange(filters.timeRange), [filters.timeRange]);

  const { data, isLoading, refetch, error } = useQuery<EventsListResult, Error>({
    queryKey: ['eventLogs', filters, pagination],
    queryFn: () =>
      fetchEvents({
        name: filters.name.trim() || undefined,
        handler: filters.handler.trim() || undefined,
        status: filters.status === 'all' ? undefined : filters.status,
        ...timeFilters,
        limit: pagination.limit,
        offset: pagination.offset,
      }),
  });

  const events: EventLog[] = data?.items ?? [];
  const total = data?.total ?? 0;
  const startIndex = total === 0 ? 0 : pagination.offset + 1;
  const endIndex = pagination.offset + events.length;
  const canPrevious = pagination.offset > 0;
  const canNext = pagination.offset + pagination.limit < total;

  useEffect(() => {
    if (events.length === 0) {
      setSelectedEventId(null);
      return;
    }

    if (!selectedEventId || !events.some((event) => event.id === selectedEventId)) {
      setSelectedEventId(events[0].id);
    }
  }, [events, selectedEventId]);

  const selectedEvent = events.find((event) => event.id === selectedEventId) ?? null;
  const selectedHandlers: EventHandlerLog[] = selectedEvent?.handlers ?? [];
  const handlerSummary = selectedEvent ? summarizeHandlers(selectedEvent.handlers) : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Events Viewer</h1>
        <p className="text-muted-foreground mt-2">
          Monitor published events and handler outcomes in real time.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          <CardDescription>Refine the events shown below.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-2">
              <Label htmlFor="filter-name">Event name</Label>
              <Input
                id="filter-name"
                value={filters.name}
                onChange={(event) => setFilters((prev) => ({ ...prev, name: event.target.value }))}
                placeholder="e.g. epic.updated"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="filter-handler">Handler</Label>
              <Input
                id="filter-handler"
                value={filters.handler}
                onChange={(event) =>
                  setFilters((prev) => ({ ...prev, handler: event.target.value }))
                }
                placeholder="e.g. EpicAssignmentNotifier"
              />
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select
                value={filters.status}
                onValueChange={(value: typeof filters.status) =>
                  setFilters((prev) => ({ ...prev, status: value }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="success">Success</SelectItem>
                  <SelectItem value="failure">Failure</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Time range</Label>
              <Select
                value={filters.timeRange}
                onValueChange={(value: typeof filters.timeRange) =>
                  setFilters((prev) => ({ ...prev, timeRange: value }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select range" />
                </SelectTrigger>
                <SelectContent>
                  {TIME_RANGE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              onClick={() => refetch()}
              variant="outline"
              size="sm"
              disabled={isLoading}
              className="flex items-center gap-2"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
            <Button
              onClick={() => setFilters(DEFAULT_FILTERS)}
              variant="ghost"
              size="sm"
              disabled={
                filters.name === DEFAULT_FILTERS.name &&
                filters.handler === DEFAULT_FILTERS.handler &&
                filters.status === DEFAULT_FILTERS.status &&
                filters.timeRange === DEFAULT_FILTERS.timeRange
              }
            >
              Clear filters
            </Button>
            {data ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Clock className="h-4 w-4" />
                <span>
                  Showing {total === 0 ? 0 : `${startIndex}–${endIndex}`} of {total} events
                </span>
              </div>
            ) : null}
          </div>
          {error instanceof Error && (
            <p className="mt-4 text-sm text-destructive">Failed to load events: {error.message}</p>
          )}
        </CardContent>
      </Card>

      <div className="flex gap-6 h-[calc(100vh-24rem)]">
        {/* Left Column - Event Log */}
        <Card className="flex-1 flex flex-col">
          <CardHeader>
            <CardTitle>Event Log</CardTitle>
            <CardDescription>Newest events appear first.</CardDescription>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col min-h-0">
            <ScrollArea className="flex-1 -mx-6 px-6">
              <div className="overflow-hidden rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[200px]">Published</TableHead>
                      <TableHead>Event</TableHead>
                      <TableHead className="w-[160px] text-center">Handlers</TableHead>
                      <TableHead className="w-[180px]">Request ID</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading && events.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                          Loading events...
                        </TableCell>
                      </TableRow>
                    ) : events.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="py-12 text-center text-muted-foreground">
                          No events found. Adjust filters or wait for new activity.
                        </TableCell>
                      </TableRow>
                    ) : (
                      events.map((event) => {
                        const summary = summarizeHandlers(event.handlers);
                        const isSelected = event.id === selectedEventId;
                        return (
                          <TableRow
                            key={event.id}
                            className={cn(
                              'cursor-pointer',
                              isSelected && 'bg-muted/60 hover:bg-muted/60',
                            )}
                            onClick={() => setSelectedEventId(event.id)}
                            aria-selected={isSelected}
                          >
                            <TableCell className="font-mono text-xs">
                              {new Date(event.publishedAt).toLocaleString()}
                            </TableCell>
                            <TableCell>
                              <div className="font-medium">{event.name}</div>
                            </TableCell>
                            <TableCell className="text-center">
                              <div className="flex items-center justify-center gap-2">
                                <Badge
                                  variant="outline"
                                  className="border-emerald-500 text-emerald-600"
                                >
                                  {summary.success} OK
                                </Badge>
                                <Badge
                                  variant="outline"
                                  className="border-destructive text-destructive"
                                >
                                  {summary.failure} Fail
                                </Badge>
                              </div>
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {event.requestId ?? '--'}
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            </ScrollArea>

            <div className="mt-4 flex items-center justify-between gap-2 pt-4 border-t">
              <div className="text-xs text-muted-foreground">
                Page {Math.floor(pagination.offset / pagination.limit) + 1} of{' '}
                {Math.max(1, Math.ceil(total / pagination.limit))}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setPagination((prev) => ({
                      ...prev,
                      offset: Math.max(0, prev.offset - prev.limit),
                    }))
                  }
                  disabled={!canPrevious || isLoading}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setPagination((prev) => ({
                      ...prev,
                      offset: prev.offset + prev.limit,
                    }))
                  }
                  disabled={!canNext || isLoading}
                >
                  Next
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Right Column - Event Details */}
        <Card className="flex-1 flex flex-col">
          <CardHeader>
            <CardTitle>Event Details</CardTitle>
            <CardDescription>Inspect payload and handler results.</CardDescription>
          </CardHeader>
          <CardContent className="flex-1 min-h-0">
            <ScrollArea className="h-full -mx-6 px-6">
              {!selectedEvent ? (
                <p className="text-sm text-muted-foreground">Select an event to view details.</p>
              ) : (
                <div className="space-y-4 pr-4">
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                      Overview
                    </h3>
                    <div className="mt-2 grid gap-3 sm:grid-cols-2">
                      <div>
                        <div className="text-xs text-muted-foreground">Event</div>
                        <div className="font-semibold">{selectedEvent.name}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Published</div>
                        <div className="font-mono text-xs">
                          {new Date(selectedEvent.publishedAt).toLocaleString()}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Request ID</div>
                        <div className="font-mono text-xs">{selectedEvent.requestId ?? '--'}</div>
                      </div>
                      {handlerSummary && (
                        <div>
                          <div className="text-xs text-muted-foreground">Handlers</div>
                          <div className="flex items-center gap-2">
                            <Badge
                              variant="outline"
                              className="border-emerald-500 text-emerald-600"
                            >
                              {handlerSummary.success} OK
                            </Badge>
                            <Badge
                              variant="outline"
                              className="border-destructive text-destructive"
                            >
                              {handlerSummary.failure} Fail
                            </Badge>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                      Payload
                    </h3>
                    <pre className="mt-2 h-48 overflow-auto rounded-lg border bg-muted/50 p-4 text-xs whitespace-pre-wrap break-all">
                      {formatJson(selectedEvent.payload)}
                    </pre>
                  </div>

                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                      Handlers
                    </h3>
                    {selectedHandlers.length === 0 ? (
                      <p className="mt-2 text-sm text-muted-foreground">
                        No handlers recorded yet.
                      </p>
                    ) : (
                      <div className="mt-2 space-y-3">
                        {selectedHandlers.map((handler) => (
                          <div key={handler.id} className="rounded-lg border p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div>
                                <div className="text-sm font-semibold">{handler.handler}</div>
                                <div className="text-xs text-muted-foreground">
                                  Started {new Date(handler.startedAt).toLocaleString()}
                                  {handler.endedAt && (
                                    <>
                                      {' - '}Ended {new Date(handler.endedAt).toLocaleString()}
                                    </>
                                  )}
                                </div>
                              </div>
                              <Badge
                                variant={handler.status === 'success' ? 'secondary' : 'destructive'}
                                className="uppercase"
                              >
                                {handler.status}
                              </Badge>
                            </div>
                            {handler.detail !== undefined && handler.detail !== null && (
                              <pre className="mt-2 h-40 overflow-auto rounded bg-muted/50 p-3 text-xs whitespace-pre-wrap break-all">
                                {formatJson(handler.detail)}
                              </pre>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
