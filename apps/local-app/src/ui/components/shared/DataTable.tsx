import { ReactNode, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  type ColumnDef,
  type SortingState,
  type Table as TanstackTable,
  type Row,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui/components/ui/table';
import { Skeleton } from '@/ui/components/ui/skeleton';
import { EmptyState } from './EmptyState';
import { cn } from '@/ui/lib/utils';

interface DataTableEmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

type ToolbarRenderer<TData> = ReactNode | ((table: TanstackTable<TData>) => ReactNode);

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  isLoading?: boolean;
  skeletonRowCount?: number;
  className?: string;
  tableClassName?: string;
  bodyClassName?: string;
  toolbar?: ToolbarRenderer<TData>;
  emptyState?: DataTableEmptyStateProps;
  getRowId?: (originalRow: TData, index: number, parent?: Row<TData>) => string;
}

export function DataTable<TData, TValue>({
  columns,
  data,
  isLoading = false,
  skeletonRowCount = 3,
  className,
  tableClassName,
  bodyClassName,
  toolbar,
  emptyState,
  getRowId,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId,
  });

  const resolvedToolbar = toolbar
    ? typeof toolbar === 'function'
      ? toolbar(table)
      : toolbar
    : null;

  const columnCount =
    table.getVisibleLeafColumns().length > 0
      ? table.getVisibleLeafColumns().length
      : columns.length;

  const showEmptyState = !isLoading && table.getRowModel().rows.length === 0;

  return (
    <section className={cn('space-y-4', className)} aria-busy={isLoading}>
      {resolvedToolbar && (
        <div className="flex items-center justify-between gap-2">{resolvedToolbar}</div>
      )}
      <div className="overflow-hidden rounded-lg border bg-card">
        <Table className={tableClassName}>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody className={bodyClassName}>
            {isLoading ? (
              Array.from({ length: skeletonRowCount }).map((_, index) => (
                <TableRow key={`loading-${index}`} className="hover:bg-transparent">
                  <TableCell colSpan={columnCount} className="py-4">
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : showEmptyState ? (
              <TableRow>
                <TableCell colSpan={columnCount} className="py-10">
                  {emptyState ? (
                    <EmptyState
                      {...emptyState}
                      className={cn('border-0 p-0 shadow-none', emptyState.className)}
                    />
                  ) : (
                    <div className="flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                      <span>No results found</span>
                      <span>Try adjusting filters or creating a new record.</span>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} data-state={row.getIsSelected() && 'selected'}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

export type { DataTableProps, DataTableEmptyStateProps };
