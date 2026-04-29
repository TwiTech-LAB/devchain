import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CodebaseOverviewSnapshot, DependencyPairDetail } from '@devchain/codebase-overview';
import { Grid3X3, ArrowLeftRight, X } from 'lucide-react';
import { fetchJsonOrThrow } from '@/ui/lib/sessions';
import { cn } from '@/ui/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { Separator } from '@/ui/components/ui/separator';
import { Skeleton } from '@/ui/components/ui/skeleton';

export type MatrixMode = 'full' | 'region' | 'focused';

const FULL_MATRIX_THRESHOLD = 20;

function fetchPairDetail(projectId: string, fromId: string, toId: string) {
  return fetchJsonOrThrow<DependencyPairDetail>(
    `/api/projects/${projectId}/codebase-overview/pairs/${fromId}/${toId}`,
  );
}

const pairDetailKey = (projectId: string, fromId: string, toId: string) =>
  ['codebase-overview', projectId, 'pair', fromId, toId] as const;

export function DependencyMatrix({
  snapshot,
  selectedTargetId,
  onSelectTarget,
  onSelectPair,
  modeOverride,
  onModeChange,
}: {
  snapshot: CodebaseOverviewSnapshot;
  selectedTargetId: string | null;
  onSelectTarget: (targetId: string) => void;
  onSelectPair: (fromId: string, toId: string) => void;
  modeOverride: MatrixMode | null;
  onModeChange: (mode: MatrixMode | null) => void;
}) {
  const recommendedMode: MatrixMode =
    snapshot.districts.length <= FULL_MATRIX_THRESHOLD ? 'full' : 'region';

  const activeMode: MatrixMode = (() => {
    const mode = modeOverride ?? recommendedMode;
    if (mode === 'focused' && !selectedTargetId) return recommendedMode;
    return mode;
  })();

  const orderedDistricts = useMemo(() => {
    const byRegion = new Map<string, typeof snapshot.districts>();
    for (const d of snapshot.districts) {
      const list = byRegion.get(d.regionId) ?? [];
      list.push(d);
      byRegion.set(d.regionId, list);
    }
    for (const list of byRegion.values()) {
      list.sort((a, b) => b.couplingScore - a.couplingScore);
    }
    const result: typeof snapshot.districts = [];
    for (const region of snapshot.regions) {
      result.push(...(byRegion.get(region.id) ?? []));
    }
    return result;
  }, [snapshot.districts, snapshot.regions]);

  const edgeMap = useMemo(() => {
    const map = new Map<string, { weight: number; isCyclic: boolean }>();
    for (const edge of snapshot.dependencies) {
      map.set(`${edge.fromDistrictId}:${edge.toDistrictId}`, edge);
    }
    return map;
  }, [snapshot.dependencies]);

  const maxWeight = useMemo(() => {
    let max = 0;
    for (const edge of snapshot.dependencies) {
      if (edge.weight > max) max = edge.weight;
    }
    return max;
  }, [snapshot.dependencies]);

  const visibleDistricts = useMemo(() => {
    if (activeMode === 'focused' && selectedTargetId) {
      const neighborIds = new Set<string>([selectedTargetId]);
      for (const edge of snapshot.dependencies) {
        if (edge.fromDistrictId === selectedTargetId) neighborIds.add(edge.toDistrictId);
        if (edge.toDistrictId === selectedTargetId) neighborIds.add(edge.fromDistrictId);
      }
      return orderedDistricts.filter((d) => neighborIds.has(d.id));
    }
    return orderedDistricts;
  }, [activeMode, selectedTargetId, snapshot.dependencies, orderedDistricts]);

  const regionStartIds = useMemo(() => {
    const starts = new Set<string>();
    let lastRegionId = '';
    for (const d of visibleDistricts) {
      if (d.regionId !== lastRegionId) {
        starts.add(d.id);
        lastRegionId = d.regionId;
      }
    }
    return starts;
  }, [visibleDistricts]);

  const regionAgg = useMemo(() => {
    if (activeMode !== 'region') return null;
    const distRegion = new Map<string, string>();
    for (const d of snapshot.districts) {
      distRegion.set(d.id, d.regionId);
    }
    const weights = new Map<string, number>();
    const cyclic = new Map<string, boolean>();
    for (const edge of snapshot.dependencies) {
      const fr = distRegion.get(edge.fromDistrictId);
      const tr = distRegion.get(edge.toDistrictId);
      if (!fr || !tr) continue;
      const key = `${fr}:${tr}`;
      weights.set(key, (weights.get(key) ?? 0) + edge.weight);
      if (edge.isCyclic) cyclic.set(key, true);
    }
    const outbound = new Map<string, number>();
    const inbound = new Map<string, number>();
    let maxW = 0;
    for (const [key, w] of weights) {
      const [fId, tId] = key.split(':');
      if (fId !== tId) {
        outbound.set(fId!, (outbound.get(fId!) ?? 0) + w);
        inbound.set(tId!, (inbound.get(tId!) ?? 0) + w);
      }
      if (w > maxW) maxW = w;
    }
    return { weights, cyclic, outbound, inbound, maxWeight: maxW };
  }, [activeMode, snapshot]);

  if (snapshot.dependencies.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Grid3X3 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <CardTitle className="text-base">Dependency Matrix</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground py-4 text-center">
            No dependency data available. Import analysis is required to populate the matrix.
          </p>
        </CardContent>
      </Card>
    );
  }

  const modeLabel: Record<MatrixMode, string> = {
    full: 'Full',
    region: 'Regions',
    focused: 'Focused',
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Grid3X3 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <CardTitle className="text-base">Dependency Matrix</CardTitle>
            <Badge variant="secondary" className="text-xs">
              {snapshot.dependencies.length} edge{snapshot.dependencies.length !== 1 ? 's' : ''}
            </Badge>
          </div>
          <div className="flex gap-1">
            {(['full', 'region', 'focused'] as MatrixMode[]).map((mode) => (
              <Button
                key={mode}
                size="sm"
                variant={activeMode === mode ? 'secondary' : 'ghost'}
                className="h-10 px-3 text-xs"
                disabled={mode === 'focused' && !selectedTargetId}
                onClick={() => onModeChange(mode)}
              >
                {modeLabel[mode]}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          {activeMode === 'region' && regionAgg ? (
            <table
              className="border-collapse text-xs"
              role="grid"
              aria-label="Region dependency matrix"
            >
              <thead>
                <tr>
                  <th className="p-1" />
                  {snapshot.regions.map((r) => (
                    <th key={r.id} className="p-1 font-normal text-muted-foreground align-bottom">
                      <span className="inline-block [writing-mode:vertical-lr] rotate-180 max-h-24 truncate">
                        {r.name}
                      </span>
                    </th>
                  ))}
                  <th className="p-1 font-medium text-muted-foreground align-bottom border-l-2 border-l-border">
                    <span className="inline-block [writing-mode:vertical-lr] rotate-180">Out</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {snapshot.regions.map((rowRegion) => (
                  <tr key={rowRegion.id}>
                    <th className="p-1 text-right font-normal text-muted-foreground whitespace-nowrap pr-2">
                      {rowRegion.name}
                    </th>
                    {snapshot.regions.map((colRegion) => {
                      if (rowRegion.id === colRegion.id) {
                        const selfW = regionAgg.weights.get(`${rowRegion.id}:${colRegion.id}`) ?? 0;
                        return (
                          <td
                            key={colRegion.id}
                            className="w-10 h-10 text-center bg-muted/30"
                            aria-label={`${rowRegion.name} internal: ${selfW}`}
                            title={selfW > 0 ? `${rowRegion.name} internal: ${selfW}` : undefined}
                          >
                            {selfW > 0 ? (
                              <span className="text-[10px] text-muted-foreground">{selfW}</span>
                            ) : (
                              <span className="text-muted-foreground/30">&mdash;</span>
                            )}
                          </td>
                        );
                      }
                      const w = regionAgg.weights.get(`${rowRegion.id}:${colRegion.id}`) ?? 0;
                      const cyc = regionAgg.cyclic.get(`${rowRegion.id}:${colRegion.id}`) ?? false;
                      const intensity =
                        regionAgg.maxWeight > 0 && w > 0
                          ? Math.max(0.08, (w / regionAgg.maxWeight) * 0.7)
                          : 0;
                      return (
                        <td
                          key={colRegion.id}
                          className={cn(
                            'w-10 h-10 text-center',
                            cyc && 'ring-1 ring-inset ring-destructive/50',
                          )}
                          style={
                            intensity > 0
                              ? { backgroundColor: `hsl(var(--primary) / ${intensity})` }
                              : undefined
                          }
                          aria-label={`${rowRegion.name} to ${colRegion.name}: weight ${w}${cyc ? ' (cyclic)' : ''}`}
                          title={
                            w > 0
                              ? `${rowRegion.name} → ${colRegion.name}: ${w}${cyc ? ' (cyclic)' : ''}`
                              : undefined
                          }
                        >
                          {w > 0 && <span className="text-[10px]">{w}</span>}
                        </td>
                      );
                    })}
                    <td className="w-10 h-10 text-center font-medium border-l-2 border-l-border text-muted-foreground">
                      {(regionAgg.outbound.get(rowRegion.id) ?? 0) > 0
                        ? regionAgg.outbound.get(rowRegion.id)
                        : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-t-border">
                  <th className="p-1 text-right font-medium text-muted-foreground pr-2">In</th>
                  {snapshot.regions.map((r) => (
                    <td
                      key={r.id}
                      className="w-10 h-10 text-center font-medium text-muted-foreground"
                    >
                      {(regionAgg.inbound.get(r.id) ?? 0) > 0 ? regionAgg.inbound.get(r.id) : ''}
                    </td>
                  ))}
                  <td className="border-l-2 border-l-border" />
                </tr>
              </tfoot>
            </table>
          ) : (
            <table
              className="border-collapse text-xs"
              role="grid"
              aria-label="District dependency matrix"
            >
              <thead>
                <tr>
                  <th className="p-1" />
                  {visibleDistricts.map((d) => (
                    <th
                      key={d.id}
                      className={cn(
                        'p-1 font-normal text-muted-foreground align-bottom',
                        regionStartIds.has(d.id) && 'border-l-2 border-l-border',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => onSelectTarget(d.id)}
                        className={cn(
                          'inline-block [writing-mode:vertical-lr] rotate-180 max-h-24 truncate hover:text-foreground transition-colors',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm',
                          d.id === selectedTargetId && 'text-foreground font-medium',
                        )}
                        title={d.name}
                      >
                        {d.name}
                      </button>
                    </th>
                  ))}
                  <th className="p-1 font-medium text-muted-foreground align-bottom border-l-2 border-l-border">
                    <span className="inline-block [writing-mode:vertical-lr] rotate-180">Out</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleDistricts.map((rowDist) => (
                  <tr
                    key={rowDist.id}
                    className={cn(regionStartIds.has(rowDist.id) && 'border-t-2 border-t-border')}
                  >
                    <th className="p-1 text-right font-normal text-muted-foreground whitespace-nowrap pr-2">
                      <button
                        type="button"
                        onClick={() => onSelectTarget(rowDist.id)}
                        className={cn(
                          'hover:text-foreground transition-colors',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm',
                          rowDist.id === selectedTargetId && 'text-foreground font-medium',
                        )}
                        title={rowDist.name}
                      >
                        {rowDist.name}
                      </button>
                    </th>
                    {visibleDistricts.map((colDist) => {
                      if (rowDist.id === colDist.id) {
                        return (
                          <td
                            key={colDist.id}
                            className={cn(
                              'w-10 h-10 text-center bg-muted/30',
                              regionStartIds.has(colDist.id) && 'border-l-2 border-l-border',
                            )}
                            aria-label={`${rowDist.name} self`}
                          >
                            <span className="text-muted-foreground/30">&mdash;</span>
                          </td>
                        );
                      }
                      const edge = edgeMap.get(`${rowDist.id}:${colDist.id}`);
                      const weight = edge?.weight ?? 0;
                      const isCyclic = edge?.isCyclic ?? false;
                      const intensity =
                        maxWeight > 0 && weight > 0
                          ? Math.max(0.08, (weight / maxWeight) * 0.7)
                          : 0;
                      return (
                        <td
                          key={colDist.id}
                          className={cn(
                            'w-10 h-10 text-center',
                            regionStartIds.has(colDist.id) && 'border-l-2 border-l-border',
                            isCyclic && 'ring-1 ring-inset ring-destructive/50',
                            weight > 0 && 'cursor-pointer hover:ring-2 hover:ring-primary/40',
                            weight > 0 &&
                              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                          )}
                          style={
                            intensity > 0
                              ? { backgroundColor: `hsl(var(--primary) / ${intensity})` }
                              : undefined
                          }
                          aria-label={`${rowDist.name} to ${colDist.name}: weight ${weight}${isCyclic ? ' (cyclic)' : ''}`}
                          title={
                            weight > 0
                              ? `${rowDist.name} → ${colDist.name}: ${weight}${isCyclic ? ' (cyclic)' : ''}`
                              : undefined
                          }
                          onClick={
                            weight > 0 ? () => onSelectPair(rowDist.id, colDist.id) : undefined
                          }
                          onKeyDown={
                            weight > 0
                              ? (e: React.KeyboardEvent) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    onSelectPair(rowDist.id, colDist.id);
                                  }
                                }
                              : undefined
                          }
                          role={weight > 0 ? 'button' : undefined}
                          tabIndex={weight > 0 ? 0 : undefined}
                        >
                          {weight > 0 && <span className="text-[10px]">{weight}</span>}
                        </td>
                      );
                    })}
                    <td className="w-10 h-10 text-center font-medium border-l-2 border-l-border text-muted-foreground">
                      {rowDist.outboundWeight > 0 ? rowDist.outboundWeight : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-t-border">
                  <th className="p-1 text-right font-medium text-muted-foreground pr-2">In</th>
                  {visibleDistricts.map((d) => (
                    <td
                      key={d.id}
                      className={cn(
                        'w-10 h-10 text-center font-medium text-muted-foreground',
                        regionStartIds.has(d.id) && 'border-l-2 border-l-border',
                      )}
                    >
                      {d.inboundWeight > 0 ? d.inboundWeight : ''}
                    </td>
                  ))}
                  <td className="border-l-2 border-l-border" />
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function PairDetailPanel({
  projectId,
  fromId,
  toId,
  snapshot,
  onClose,
}: {
  projectId: string;
  fromId: string;
  toId: string;
  snapshot: CodebaseOverviewSnapshot;
  onClose: () => void;
}) {
  const { data: pairDetail, isLoading } = useQuery({
    queryKey: pairDetailKey(projectId, fromId, toId),
    queryFn: () => fetchPairDetail(projectId, fromId, toId),
  });

  const fromDistrict = snapshot.districts.find((d) => d.id === fromId);
  const toDistrict = snapshot.districts.find((d) => d.id === toId);
  const fromName = fromDistrict?.name ?? fromId;
  const toName = toDistrict?.name ?? toId;

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <Skeleton className="h-6 w-64" />
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!pairDetail) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ArrowLeftRight className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">
                {fromName} → {toName}
              </CardTitle>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No pair detail available.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ArrowLeftRight className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">
              {fromName} → {toName}
            </CardTitle>
            <Badge variant="outline" className="text-xs">
              weight {pairDetail.weight}
            </Badge>
            {pairDetail.isCyclic && (
              <Badge variant="destructive" className="text-xs">
                cyclic
              </Badge>
            )}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm">{pairDetail.summary}</p>

        {pairDetail.exemplarFileEdges.length > 0 && (
          <>
            <Separator />
            <div>
              <h4 className="text-sm font-medium mb-2">File-level edges</h4>
              <div className="space-y-1">
                {pairDetail.exemplarFileEdges.map((edge, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span className="truncate min-w-0 flex-1 font-mono text-xs">
                      {edge.fromPath}
                    </span>
                    <span className="shrink-0">→</span>
                    <span className="truncate min-w-0 flex-1 font-mono text-xs">{edge.toPath}</span>
                    {edge.weight > 1 && (
                      <Badge variant="secondary" className="shrink-0 text-[10px]">
                        {edge.weight}
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
