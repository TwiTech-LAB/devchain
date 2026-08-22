import type { FormEvent } from 'react';
import type { EpicFormData } from '@/ui/components/board/EpicFormDialog';
import type { EpicExternalSourceMap } from '@/ui/hooks/useEpicExternalSourcesBatch';
import type { BoardFilterParams } from '@/ui/lib/url-filters';
import type { Agent, Epic, Status } from '@/ui/types';
import type { BoardBulkEditController } from '@/ui/types/board-bulk-edit';

/**
 * Stored external sources by Epic ID for the loaded Board context. One
 * bounded batch read; native Epics simply have no entry. The shape is owned by
 * the hook that produces it — this is the Board-facing name for it.
 */
export type BoardExternalSourceMap = EpicExternalSourceMap;

export interface BoardHeaderModel {
  readonly hasProject: boolean;
  readonly projectName: string | null;
}

export interface BoardToolbarModel {
  readonly projectId: string;
  readonly currentViewMode: 'kanban' | 'list';
  readonly filters: BoardFilterParams;
  readonly hasActiveFilters: boolean;
  readonly filterPopoverOpen: boolean;
  readonly columnPickerOpen: boolean;
  readonly statuses: Status[];
  readonly collapsedStatusIds: string[];
  readonly statusEpicCounts: Readonly<Record<string, number>>;
  changeViewMode(mode: 'kanban' | 'list'): void;
  applySavedFilter(queryString: string): void;
  changeFilterPopoverOpen(open: boolean): void;
  clearStatuses(): void;
  toggleStatus(statusId: string): void;
  changeArchivedVisible(visible: boolean): void;
  changeColumnPickerOpen(open: boolean): void;
  toggleColumn(statusId: string): void;
  collapseAll(): void;
  resetDefaults(): void;
}

export interface BoardParentBannerModel {
  readonly parentName: string;
  readonly isLoading: boolean;
  clear(): void;
}

interface BoardKanbanColumnBase {
  readonly status: Status;
  readonly epics: Epic[];
  readonly activeParentId: string | null;
  readonly isActiveDrop: boolean;
  readonly statusOrder: Status[];
  readonly subEpicCounts: Readonly<Record<string, number>>;
  readonly subEpicStatusCountsByEpicId: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly hasRunningWorktrees: boolean;
  getAgentName(agentId: string | null): string | null;
  addEpic(statusId: string): void;
  editEpic(epic: Epic): void;
  deleteEpic(epic: Epic): void;
  openBulkEdit(epic: Epic): void;
  openEpicDetails(epic: Epic): void;
  toggleParentFilter(epic: Epic): void;
  moveToWorktree(epic: Epic): void;
  dragStart(epic: Epic): void;
  dragEnd(): void;
  dragOver(): void;
  drop(): void;
}

export interface BoardCollapsedColumnModel extends BoardKanbanColumnBase {
  readonly kind: 'collapsed';
  expand(): void;
}

export interface BoardExpandedColumnModel extends BoardKanbanColumnBase {
  readonly kind: 'expanded';
  readonly draggedEpic: Epic | null;
  /** Sources for this column's imported Epics; collapsed columns show none. */
  readonly externalSources: BoardExternalSourceMap;
  collapse(): void;
  keyboardMove(epic: Epic, direction: 'left' | 'right'): void;
}

export type BoardKanbanColumnModel = BoardCollapsedColumnModel | BoardExpandedColumnModel;

export interface BoardKanbanContentModel {
  readonly kind: 'kanban';
  readonly columns: readonly BoardKanbanColumnModel[];
}

export interface BoardListContentModel {
  readonly kind: 'list';
  readonly epics: Epic[];
  readonly statuses: Status[];
  readonly agents: Agent[];
  readonly pageSize: number;
  readonly currentPage: number;
  readonly subEpicCounts: Readonly<Record<string, number>>;
  readonly hasRunningWorktrees: boolean;
  changePage(page: number): void;
  changePageSize(pageSize: number): void;
  editEpic(epic: Epic): void;
  deleteEpic(epic: Epic): void;
  deleteEpics(epicIds: string[]): void;
  openEpicDetails(epic: Epic): void;
  openBulkEdit(epic: Epic): void;
  toggleParentFilter(epic: Epic): void;
  changeStatus(epic: Epic, statusId: string): Promise<void>;
  changeAgent(epic: Epic, agentId: string | null): Promise<void>;
  moveToWorktree(epic: Epic): void;
  /** Sources for main rows; lazily expanded sub-epic rows show none. */
  readonly externalSources: BoardExternalSourceMap;
}

export type BoardContentModel =
  | { readonly kind: 'no-project' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'no-statuses'; openStatusManagement(): void }
  | BoardKanbanContentModel
  | BoardListContentModel;

export interface BoardCreateDialogModel {
  readonly isOpen: boolean;
  readonly activeProjectName: string | undefined;
  readonly formData: EpicFormData;
  readonly parentCandidates: Epic[];
  readonly hasParentFilter: boolean;
  readonly activeParent: Epic | null;
  readonly isSubmitting: boolean;
  changeOpen(open: boolean): void;
  changeForm(data: EpicFormData): void;
  cancel(): void;
  submit(event: FormEvent): void;
}

export interface BoardDeleteDialogModel {
  readonly epic: Epic | null;
  readonly isSubmitting: boolean;
  changeOpen(open: boolean): void;
  close(): void;
  confirm(): void;
}

export interface BoardBulkDeleteDialogModel {
  readonly epicCount: number;
  readonly isOpen: boolean;
  readonly isSubmitting: boolean;
  changeOpen(open: boolean): void;
  close(): void;
  confirm(): void;
}

export interface BoardMoveToWorktreeDialogModel {
  readonly epic: Epic | null;
  readonly statuses: Status[];
  readonly agents: Agent[];
  changeOpen(open: boolean): void;
}

export interface BoardDialogsModel {
  readonly create: BoardCreateDialogModel;
  readonly deleteEpic: BoardDeleteDialogModel;
  readonly bulkDelete: BoardBulkDeleteDialogModel;
  readonly bulkEdit: {
    readonly controller: BoardBulkEditController;
    readonly statuses: Status[];
    readonly agents: Agent[];
  };
  readonly moveToWorktree: BoardMoveToWorktreeDialogModel;
}

export interface BoardPagePresentation {
  readonly header: BoardHeaderModel;
  readonly toolbar: BoardToolbarModel | null;
  readonly parentBanner: BoardParentBannerModel | null;
  readonly content: BoardContentModel;
  readonly dialogs: BoardDialogsModel;
}
