import { AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { useDebugMetrics, type DebugMetricsSnapshot } from '@/ui/hooks/useDebugMetrics';

export function formatMetricBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const signed = bytes < 0 ? -value : value;
  return `${signed.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function DeltaBadge({ value }: { value: number }) {
  const sign = value > 0 ? '+' : '';
  return (
    <Badge variant="secondary">
      {sign}
      {formatMetricBytes(value)} since opened
    </Badge>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-mono text-sm font-semibold">{value}</dd>
    </div>
  );
}

function memoryDelta(
  history: DebugMetricsSnapshot[],
  selector: (item: DebugMetricsSnapshot) => number,
) {
  if (history.length < 2) return 0;
  return selector(history[history.length - 1]) - selector(history[0]);
}

export function MemoryMetricsCard() {
  const { data, history, isLoading, isRefetching, error, refetch } = useDebugMetrics();

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>Memory &amp; Caches</CardTitle>
            <CardDescription>Live backend process and retained-cache counters</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isRefetching}>
            {isRefetching ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Update metrics
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading && (
          <div className="flex items-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading memory metrics…
          </div>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Memory metrics unavailable</AlertTitle>
            <AlertDescription className="flex items-center justify-between gap-4">
              <span>
                {error instanceof Error
                  ? error.message
                  : 'The metrics endpoint could not be reached.'}
              </span>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {data && (
          <>
            <section aria-labelledby="process-memory-heading" className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="process-memory-heading" className="text-sm font-semibold">
                  Process memory
                </h3>
                <DeltaBadge value={memoryDelta(history, (item) => item.process.memory.rss)} />
              </div>
              <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <Metric label="RSS" value={formatMetricBytes(data.process.memory.rss)} />
                <Metric label="Heap used" value={formatMetricBytes(data.process.memory.heapUsed)} />
                <Metric
                  label="Heap total"
                  value={formatMetricBytes(data.process.memory.heapTotal)}
                />
                <Metric label="External" value={formatMetricBytes(data.process.memory.external)} />
                <Metric
                  label="Array buffers"
                  value={formatMetricBytes(data.process.memory.arrayBuffers)}
                />
              </dl>
            </section>

            <section aria-labelledby="cache-heading" className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="cache-heading" className="text-sm font-semibold">
                  Caches
                </h3>
                <div className="flex flex-wrap gap-2">
                  <DeltaBadge
                    value={memoryDelta(history, (item) => item.caches.aggregate.bytesEstimated)}
                  />
                  {(data.caches.aggregate.providersFailed ?? 0) > 0 && (
                    <Badge variant="destructive">
                      {data.caches.aggregate.providersFailed} provider
                      {data.caches.aggregate.providersFailed === 1 ? '' : 's'} failed
                    </Badge>
                  )}
                </div>
              </div>
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="p-3">Cache</th>
                      <th className="p-3">Entries</th>
                      <th className="p-3">Estimated bytes</th>
                      <th className="p-3">Hit rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(data.caches).map(([name, cache]) => (
                      <tr
                        key={name}
                        className={
                          name === 'aggregate' ? 'border-t bg-muted/30 font-semibold' : 'border-t'
                        }
                      >
                        <td className="p-3 capitalize">{name}</td>
                        <td className="p-3 font-mono">{cache.entries}</td>
                        <td className="p-3 font-mono">{formatMetricBytes(cache.bytesEstimated)}</td>
                        <td className="p-3 font-mono">{(cache.hitRate * 100).toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section aria-labelledby="runtime-heading" className="space-y-3">
              <h3 id="runtime-heading" className="text-sm font-semibold">
                Runtime
              </h3>
              <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Metric
                  label="Frame buffers"
                  value={formatMetricBytes(data.frameBuffers.bytesEstimated)}
                />
                <Metric label="Active PTYs" value={data.pty.activeSessions} />
                <Metric label="Connected sockets" value={data.sockets.connectedClients} />
                <Metric
                  label="Event loop mean / p99"
                  value={
                    data.process.eventLoopDelay
                      ? `${data.process.eventLoopDelay.meanMs.toFixed(2)} / ${data.process.eventLoopDelay.p99Ms.toFixed(2)} ms`
                      : '—'
                  }
                />
              </dl>
              <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {Object.entries(data.process.listeners).map(([name, count]) => (
                  <Metric key={name} label={`${name} listeners`} value={count} />
                ))}
              </dl>
            </section>
            <p className="text-xs text-muted-foreground">
              Last sampled: {new Date(data.timestamp).toLocaleString()} · {history.length}/{60}{' '}
              local samples retained
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
