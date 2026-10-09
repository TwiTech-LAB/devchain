import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FileText, Loader2, Search, Trash2 } from 'lucide-react';
import type { TerminalHandle } from '@/ui/components/Terminal';
import { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { ScrollArea } from '@/ui/components/ui/scroll-area';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import {
  deleteCustomPrompt,
  fetchValidatedCustomPrompt,
  type CustomPromptApiTarget,
  useCustomPrompts,
} from '@/ui/hooks/chat/useCustomPrompts';
import { promptQueryKeys, type PromptSummary } from '@/ui/lib/prompts';
import { cn } from '@/ui/lib/utils';

export interface CustomPromptPickerTarget extends CustomPromptApiTarget {
  sessionId: string;
  terminalHandle: TerminalHandle;
}

interface CustomPromptPickerProps {
  open: boolean;
  target: CustomPromptPickerTarget;
  onOpenChange: (open: boolean) => void;
}

export function CustomPromptPicker({ open, target, onOpenChange }: CustomPromptPickerProps) {
  const queryClient = useQueryClient();
  const { prompts, isLoading, error: listError, removePrompt } = useCustomPrompts(open, target);
  const [search, setSearch] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);
  const [pendingDeletePrompt, setPendingDeletePrompt] = useState<PromptSummary | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deletingPromptId, setDeletingPromptId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectingRef = useRef(false);
  const restoreTerminalFocusRef = useRef(false);
  const selectionGenerationRef = useRef(0);
  const selectionAbortRef = useRef<AbortController | null>(null);

  const invalidateSelection = useCallback(() => {
    selectionGenerationRef.current += 1;
    selectionAbortRef.current?.abort();
    selectionAbortRef.current = null;
    selectingRef.current = false;
  }, []);

  useLayoutEffect(() => {
    invalidateSelection();
    if (!open) {
      return;
    }
    setSearch('');
    setActionError(null);
    setSelectedPromptId(null);
    setConfirmDeleteOpen(false);
    setDeletingPromptId(null);
    selectingRef.current = false;
    return invalidateSelection;
  }, [invalidateSelection, open, target]);

  const filteredPrompts = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) {
      return prompts;
    }
    return prompts.filter((prompt) => prompt.title.toLocaleLowerCase().includes(query));
  }, [prompts, search]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        invalidateSelection();
      }
      onOpenChange(nextOpen);
    },
    [invalidateSelection, onOpenChange],
  );

  const handleSelect = useCallback(
    async (promptId: string) => {
      if (selectingRef.current) {
        return;
      }

      selectingRef.current = true;
      const selectionGeneration = selectionGenerationRef.current + 1;
      selectionGenerationRef.current = selectionGeneration;
      const controller = new AbortController();
      selectionAbortRef.current?.abort();
      selectionAbortRef.current = controller;
      setSelectedPromptId(promptId);
      setActionError(null);

      try {
        const prompt = await fetchValidatedCustomPrompt(target, promptId, controller.signal);
        if (controller.signal.aborted || selectionGenerationRef.current !== selectionGeneration) {
          return;
        }
        await target.terminalHandle.insertPromptText(prompt.content);
        if (controller.signal.aborted || selectionGenerationRef.current !== selectionGeneration) {
          return;
        }
        restoreTerminalFocusRef.current = true;
        onOpenChange(false);
      } catch (cause: unknown) {
        if (controller.signal.aborted || selectionGenerationRef.current !== selectionGeneration) {
          return;
        }
        selectingRef.current = false;
        setSelectedPromptId(null);
        setActionError(
          cause instanceof Error ? cause.message : 'Failed to insert the selected custom prompt.',
        );
      } finally {
        if (selectionGenerationRef.current === selectionGeneration) {
          selectionAbortRef.current = null;
        }
      }
    },
    [onOpenChange, target],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDeletePrompt) {
      return;
    }
    const promptId = pendingDeletePrompt.id;
    setConfirmDeleteOpen(false);
    setDeletingPromptId(promptId);
    setActionError(null);

    try {
      await deleteCustomPrompt(target, promptId);
      removePrompt(promptId);
      void queryClient.invalidateQueries({ queryKey: promptQueryKeys.project(target.projectId) });
    } catch (cause: unknown) {
      setActionError(
        cause instanceof Error ? cause.message : 'Failed to delete the custom prompt.',
      );
    } finally {
      setDeletingPromptId(null);
      searchRef.current?.focus();
    }
  }, [pendingDeletePrompt, queryClient, removePrompt, target]);

  const isBusy = selectedPromptId !== null || deletingPromptId !== null;

  const liveMessage =
    actionError ??
    listError ??
    (isLoading
      ? 'Loading custom prompts.'
      : selectedPromptId
        ? 'Inserting custom prompt.'
        : deletingPromptId
          ? 'Deleting custom prompt.'
          : `${filteredPrompts.length} custom prompt${filteredPrompts.length === 1 ? '' : 's'} available.`);

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          className="max-w-xl"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            setTimeout(() => searchRef.current?.focus(), 0);
          }}
          onCloseAutoFocus={(event) => {
            if (!restoreTerminalFocusRef.current) {
              return;
            }
            event.preventDefault();
            restoreTerminalFocusRef.current = false;
            target.terminalHandle.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Insert custom prompt</DialogTitle>
            <DialogDescription>
              Choose a project prompt to place in the terminal input without submitting it.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="custom-prompt-search">Search prompts</Label>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  id="custom-prompt-search"
                  ref={searchRef}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search by title"
                  className="pl-9"
                  autoComplete="off"
                />
              </div>
            </div>

            <p
              className={actionError || listError ? 'text-sm text-destructive' : 'sr-only'}
              role={actionError || listError ? 'alert' : 'status'}
              aria-live={actionError || listError ? 'assertive' : 'polite'}
            >
              {liveMessage}
            </p>

            <ScrollArea className="h-72 rounded-md border">
              {isLoading ? (
                <div className="flex h-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Loading custom prompts…
                </div>
              ) : listError ? (
                <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                  Custom prompts could not be loaded.
                </div>
              ) : filteredPrompts.length === 0 ? (
                <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                  {search
                    ? 'No custom prompts match your search.'
                    : 'No custom prompts are available.'}
                </div>
              ) : (
                <TooltipProvider delayDuration={300}>
                  <div className="divide-y p-1">
                    {filteredPrompts.map((prompt) => {
                      const isSelected = selectedPromptId === prompt.id;
                      const isDeleting = deletingPromptId === prompt.id;
                      return (
                        <Tooltip key={prompt.id}>
                          <TooltipTrigger asChild>
                            <div className="group flex items-center gap-1 rounded-sm pr-1 transition-colors hover:bg-accent hover:text-accent-foreground">
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleSelect(prompt.id)}
                                className="flex min-w-0 flex-1 items-center gap-3 rounded-sm px-3 py-2.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
                              >
                                {isSelected ? (
                                  <Loader2
                                    className="h-4 w-4 shrink-0 animate-spin"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <FileText
                                    className="h-4 w-4 shrink-0 text-muted-foreground"
                                    aria-hidden="true"
                                  />
                                )}
                                <span className="min-w-0 flex-1 truncate">{prompt.title}</span>
                                <span className="sr-only">Prompt ID {prompt.id}</span>
                              </button>
                              <button
                                type="button"
                                aria-label={`Delete prompt ${prompt.title}`}
                                disabled={isBusy}
                                onClick={() => {
                                  setPendingDeletePrompt(prompt);
                                  setConfirmDeleteOpen(true);
                                }}
                                className={cn(
                                  'shrink-0 rounded-sm p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 disabled:pointer-events-none',
                                  isDeleting && 'opacity-100',
                                )}
                              >
                                {isDeleting ? (
                                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                                ) : (
                                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                                )}
                              </button>
                            </div>
                          </TooltipTrigger>
                          {prompt.contentPreview ? (
                            <TooltipContent
                              side="right"
                              align="start"
                              className="max-w-sm whitespace-pre-wrap break-words text-xs"
                            >
                              {prompt.contentPreview}
                            </TooltipContent>
                          ) : null}
                        </Tooltip>
                      );
                    })}
                  </div>
                </TooltipProvider>
              )}
            </ScrollArea>
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        onConfirm={() => void handleConfirmDelete()}
        title="Delete prompt?"
        description={`Delete "${pendingDeletePrompt?.title ?? ''}"? This cannot be undone.`}
        confirmText="Delete"
        cancelText="Cancel"
        variant="destructive"
      />
    </>
  );
}
