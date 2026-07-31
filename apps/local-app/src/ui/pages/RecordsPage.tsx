import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Loader2, FileText, Filter } from 'lucide-react';
import {
  PageHeader,
  EmptyState,
  JsonViewer,
  DataTable,
  type DataTableProps,
} from '@/ui/components/shared';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { useBreadcrumbs } from '@/ui/hooks/useBreadcrumbs';

interface EpicSummary {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  statusId: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface EpicListResponse {
  items: EpicSummary[];
  total?: number;
}

interface EpicRecordListItem {
  id: string;
  epicId: string;
  type: string;
  data: Record<string, unknown>;
  tags: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface RecordsListResponse {
  items: EpicRecordListItem[];
  total: number;
  limit: number;
  offset: number;
}

async function fetchEpics(projectId: string): Promise<EpicListResponse> {
  const res = await fetch(`/api/epics?projectId=${projectId}`);
  if (!res.ok) {
    throw new Error('Failed to load epics');
  }
  return res.json();
}

async function fetchRecords(epicId: string, type?: string): Promise<RecordsListResponse> {
  const params = new URLSearchParams({ epicId, limit: '100', offset: '0' });
  if (type && type !== 'all') {
    params.set('type', type);
  }
  const res = await fetch(`/api/records?${params.toString()}`);
  if (!res.ok) {
    throw new Error('Failed to load records');
  }
  return res.json();
}

const TYPE_ALL = 'all';

export function RecordsPage() {
  const { selectedProjectId, projectsLoading } = useSelectedProject();
  const { setBreadcrumbs, clearBreadcrumbs } = useBreadcrumbs();
  const [selectedEpicId, setSelectedEpicId] = useState<string | undefined>();
  const [selectedRecord, setSelectedRecord] = useState<EpicRecordListItem | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>(TYPE_ALL);

  const {
    data: epicsData,
    isLoading: epicsLoading,
    isError: epicsError,
    refetch: refetchEpics,
  } = useQuery({
    queryKey: ['records', 'epics', selectedProjectId],
    queryFn: () => fetchEpics(selectedProjectId!),
    enabled: !!selectedProjectId,
  });

  useEffect(() => {
    const epics = epicsData?.items ?? [];
    if (!epics.length) {
      setSelectedEpicId(undefined);
      return;
    }
    const firstEpicId = epics[0].id;
    setSelectedEpicId((current) => {
      if (current && epics.some((epic) => epic.id === current)) {
        return current;
      }
      return firstEpicId;
    });
  }, [epicsData]);

  useEffect(() => {
    setSelectedRecord(null);
  }, [selectedEpicId]);

  useEffect(() => {
    const baseCrumbs = [{ label: 'Records', href: '/records' }];
    const epicTitle = epicsData?.items?.find((epic) => epic.id === selectedEpicId)?.title;
    const nextCrumbs = epicTitle ? [...baseCrumbs, { label: epicTitle }] : baseCrumbs;
    setBreadcrumbs(nextCrumbs);
    return () => {
      clearBreadcrumbs();
    };
  }, [setBreadcrumbs, clearBreadcrumbs, epicsData, selectedEpicId]);

  const {
    data: recordsData,
    isLoading: recordsLoading,
    isError: recordsError,
    refetch: refetchRecords,
  } = useQuery({
    queryKey: ['records', 'list', selectedEpicId, typeFilter],
    queryFn: () => fetchRecords(selectedEpicId!, typeFilter),
    enabled: !!selectedEpicId,
  });

  const handleEpicChange = useCallback((value: string) => {
    setSelectedEpicId(value);
  }, []);

  const handleTypeChange = useCallback((value: string) => {
    setTypeFilter(value);
  }, []);

  const handleViewRecord = useCallback((record: EpicRecordListItem) => {
    setSelectedRecord(record);
  }, []);

  const records = recordsData?.items ?? [];

  const typeOptions = useMemo(() => {
    const unique = new Set<string>();
    records.forEach((record) => {
      if (record.type) {
        unique.add(record.type);
      }
    });
    return [TYPE_ALL, ...Array.from(unique.values()).sort()];
  }, [records]);

  const columns = useMemo<DataTableProps<EpicRecordListItem, unknown>['columns']>(() => {
    return [
      {
        accessorKey: 'type',
        header: 'Type',
        cell: ({ row }) => (
          <span className="font-medium text-foreground">{row.original.type || '—'}</span>
        ),
      },
      {
        id: 'tags',
        header: 'Tags',
        cell: ({ row }) =>
          row.original.tags.length ? (
            <div className="flex flex-wrap gap-1">
              {row.original.tags.map((tag) => (
                <Badge key={tag} variant="secondary">
                  {tag}
                </Badge>
              ))}
            </div>
          ) : (
            <span className="text-muted-foreground">No tags</span>
          ),
      },
      {
        accessorKey: 'updatedAt',
        header: 'Updated',
        cell: ({ row }) => (
          <time dateTime={row.original.updatedAt} className="text-sm text-muted-foreground">
            {new Date(row.original.updatedAt).toLocaleString()}
          </time>
        ),
      },
      {
        id: 'preview',
        header: 'Preview',
        cell: ({ row }) => {
          const preview = JSON.stringify(row.original.data);
          return (
            <span className="line-clamp-2 text-[13px] text-muted-foreground">
              {preview.length > 120 ? `${preview.slice(0, 120)}…` : preview}
            </span>
          );
        },
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="sm"
            className="text-primary"
            onClick={() => handleViewRecord(row.original)}
          >
            View
          </Button>
        ),
      },
    ];
  }, [handleViewRecord]);

  const hasProject = !!selectedProjectId;
  const hasEpics = !!epicsData?.items?.length;

  const refreshData = useCallback(async () => {
    if (selectedProjectId) {
      await refetchEpics();
    }
    if (selectedEpicId) {
      await refetchRecords();
    }
  }, [selectedProjectId, selectedEpicId, refetchEpics, refetchRecords]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Records"
        description="Browse agent-generated records by epic and inspect their structured data."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={refreshData}
            disabled={recordsLoading || epicsLoading}
          >
            {recordsLoading || epicsLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Refreshing
              </>
            ) : (
              <>
                <Loader2 className="mr-2 h-4 w-4" />
                Refresh
              </>
            )}
          </Button>
        }
      />

      {!projectsLoading && !hasProject && (
        <EmptyState
          icon={FileText}
          title="Select a project to view records"
          description="Choose a project from the header selector to load its epics and associated records."
          className="bg-card/50"
        />
      )}

      {projectsLoading && (
        <div className="flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading projects…
        </div>
      )}

      {hasProject && (
        <Card>
          <CardHeader className="flex flex-col gap-4 border-b border-border sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-base font-semibold">Filters</CardTitle>
              <p className="text-sm text-muted-foreground">
                Narrow records by epic and record type. Records are scoped to the selected project.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium uppercase text-muted-foreground">Epic</span>
                <Select
                  onValueChange={handleEpicChange}
                  value={selectedEpicId}
                  disabled={epicsLoading || !hasEpics}
                >
                  <SelectTrigger className="w-[260px]">
                    <SelectValue placeholder={epicsLoading ? 'Loading epics…' : 'Select an epic'} />
                  </SelectTrigger>
                  <SelectContent>
                    {epicsData?.items?.map((epic) => (
                      <SelectItem key={epic.id} value={epic.id}>
                        {epic.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium uppercase text-muted-foreground flex items-center gap-1">
                  <Filter className="h-3.5 w-3.5" />
                  Type
                </span>
                <Select
                  value={typeFilter}
                  onValueChange={handleTypeChange}
                  disabled={recordsLoading}
                >
                  <SelectTrigger className="w-[200px]">
                    <SelectValue placeholder="All types" />
                  </SelectTrigger>
                  <SelectContent>
                    {typeOptions.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option === TYPE_ALL ? 'All types' : option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            {!hasEpics && !epicsLoading && (
              <EmptyState
                icon={FileText}
                title="No epics available"
                description="Create an epic first to start capturing records."
              />
            )}

            {epicsError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                Failed to load epics. Try refreshing the page.
              </div>
            )}

            {recordsError && (
              <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                Failed to load records. Adjust your filters or try refreshing.
              </div>
            )}

            {hasEpics && (
              <DataTable<EpicRecordListItem, unknown>
                columns={columns}
                data={records}
                isLoading={recordsLoading}
                emptyState={{
                  icon: FileText,
                  title: 'No records yet',
                  description: 'Records created by agents will appear here once available.',
                }}
              />
            )}
          </CardContent>
        </Card>
      )}

      {selectedRecord && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">Record Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-muted-foreground">Type:</span>
                <span className="font-medium text-foreground">{selectedRecord.type || '—'}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-muted-foreground">Tags:</span>
                {selectedRecord.tags.length ? (
                  <div className="flex flex-wrap gap-1">
                    {selectedRecord.tags.map((tag) => (
                      <Badge key={tag} variant="secondary">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <span className="text-muted-foreground">No tags</span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>Updated:</span>
                <time dateTime={selectedRecord.updatedAt}>
                  {new Date(selectedRecord.updatedAt).toLocaleString()}
                </time>
              </div>
            </div>
            <JsonViewer data={selectedRecord.data} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
