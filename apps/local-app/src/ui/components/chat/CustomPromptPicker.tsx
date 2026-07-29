import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FileText, Loader2, Search } from 'lucide-react';
import type { TerminalHandle } from '@/ui/components/Terminal';
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
  fetchValidatedCustomPrompt,
  type CustomPromptApiTarget,
  useCustomPrompts,
} from '@/ui/hooks/chat/useCustomPrompts';

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
  const { prompts, isLoading, error: listError } = useCustomPrompts(open, target);
  const [search, setSearch] = useState('');
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);
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
    setSelectionError(null);
    setSelectedPromptId(null);
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
      setSelectionError(null);

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
        setSelectionError(
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

  const liveMessage =
    selectionError ??
    listError ??
    (isLoading
      ? 'Loading custom prompts.'
      : selectedPromptId
        ? 'Inserting custom prompt.'
        : `${filteredPrompts.length} custom prompt${filteredPrompts.length === 1 ? '' : 's'} available.`);

  return (
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
            className={selectionError || listError ? 'text-sm text-destructive' : 'sr-only'}
            role={selectionError || listError ? 'alert' : 'status'}
            aria-live={selectionError || listError ? 'assertive' : 'polite'}
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
              <div className="divide-y p-1">
                {filteredPrompts.map((prompt) => {
                  const isSelected = selectedPromptId === prompt.id;
                  return (
                    <button
                      key={prompt.id}
                      type="button"
                      disabled={selectedPromptId !== null}
                      onClick={() => void handleSelect(prompt.id)}
                      className="flex w-full items-center gap-3 rounded-sm px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
                    >
                      {isSelected ? (
                        <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
                      ) : (
                        <FileText
                          className="h-4 w-4 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate">{prompt.title}</span>
                      <span className="sr-only">Prompt ID {prompt.id}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}
