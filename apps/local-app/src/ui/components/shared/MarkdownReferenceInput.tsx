'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Textarea, type TextareaProps } from '@/ui/components/ui/textarea';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/components/ui/popover';
import { cn } from '@/ui/lib/utils';
import { FileText, Hash, Loader2, ScrollText } from 'lucide-react';

type DocumentSummary = {
  id: string;
  title: string;
  slug: string;
  tags: string[];
  projectId: string | null;
};

type PromptSummary = {
  id: string;
  title: string;
  tags: string[];
  projectId: string | null;
};

type SuggestionItem =
  | {
      kind: 'tag-group';
      key: string;
    }
  | {
      kind: 'document';
      document: DocumentSummary;
    }
  | {
      kind: 'prompt';
      prompt: PromptSummary;
    };

type ActiveToken =
  | {
      type: 'tagKey';
      start: number;
      end: number;
      value: string;
      fullValue: string;
      key: string;
    }
  | {
      type: 'mention';
      start: number;
      end: number;
      value: string;
      fullValue: string;
    };

const TOKEN_BOUNDARY = /[\s\[\]\(\)\{\}"'`~!$%^&*+=|\\;,.<>/?]/;
const MAX_DEFAULT_SUGGESTIONS = 7;

interface MarkdownReferenceInputProps
  extends Omit<TextareaProps, 'value' | 'onChange' | 'onKeyDown' | 'onChangeCapture'> {
  value: string;
  onChange: (value: string) => void;
  projectId?: string | null;
  maxSuggestions?: number;
}

interface DebouncedToken {
  type: ActiveToken['type'];
  value: string;
}

async function fetchDocumentSuggestions({
  mode,
  value,
  projectId,
  limit,
}: {
  mode: 'tagKey' | 'search';
  value: string;
  projectId?: string | null;
  limit: number;
}): Promise<DocumentSummary[]> {
  const params = new URLSearchParams();
  params.set('limit', `${limit}`);
  params.set('offset', '0');

  if (projectId !== undefined) {
    params.set('projectId', projectId === null ? '' : projectId);
  }

  if (mode === 'tagKey') {
    params.append('tagKey', value);
  } else {
    params.set('q', value);
  }

  const response = await fetch(`/api/documents?${params.toString()}`);
  if (!response.ok) {
    throw new Error('Failed to fetch document suggestions');
  }
  const data = (await response.json()) as { items: DocumentSummary[] };
  return data.items ?? [];
}

async function fetchPromptSuggestions({
  value,
  projectId,
  limit,
}: {
  value: string;
  projectId?: string | null;
  limit: number;
}): Promise<PromptSummary[]> {
  // Prompts require projectId
  if (projectId === undefined) {
    return [];
  }

  const params = new URLSearchParams();
  params.set('projectId', projectId === null ? '' : projectId);
  params.set('q', value);
  params.set('limit', `${limit}`);
  params.set('offset', '0');

  const response = await fetch(`/api/prompts?${params.toString()}`);
  if (!response.ok) {
    // Silently fail for prompts - documents are primary
    return [];
  }
  const data = (await response.json()) as { items: PromptSummary[] };
  return data.items ?? [];
}

interface CombinedSuggestions {
  documents: DocumentSummary[];
  prompts: PromptSummary[];
}

async function fetchCombinedSuggestions({
  mode,
  value,
  projectId,
  limit,
}: {
  mode: 'tagKey' | 'search';
  value: string;
  projectId?: string | null;
  limit: number;
}): Promise<CombinedSuggestions> {
  // For tag searches, only fetch documents
  if (mode === 'tagKey') {
    const documents = await fetchDocumentSuggestions({ mode, value, projectId, limit });
    return { documents, prompts: [] };
  }

  // For @ mentions, fetch both in parallel
  const [documents, prompts] = await Promise.all([
    fetchDocumentSuggestions({ mode, value, projectId, limit }),
    fetchPromptSuggestions({ value, projectId, limit }),
  ]);

  return { documents, prompts };
}

function detectReferenceToken(text: string, caret: number | null): ActiveToken | null {
  if (caret === null) {
    return null;
  }

  let index = caret - 1;
  let tokenStart = -1;

  while (index >= 0) {
    const char = text[index];
    if (char === '#' || char === '@') {
      tokenStart = index;
      break;
    }
    if (TOKEN_BOUNDARY.test(char)) {
      return null;
    }
    index -= 1;
  }

  if (tokenStart === -1) {
    return null;
  }

  if (tokenStart > 0 && !TOKEN_BOUNDARY.test(text[tokenStart - 1])) {
    return null;
  }

  const trigger = text[tokenStart];
  const caretIdx = caret;

  let tokenEnd = caretIdx;
  while (tokenEnd < text.length && !TOKEN_BOUNDARY.test(text[tokenEnd])) {
    const nextChar = text[tokenEnd];
    if (nextChar === '#' || nextChar === '@') {
      break;
    }
    tokenEnd += 1;
  }

  const value = text.slice(tokenStart + 1, caretIdx);
  const fullValue = text.slice(tokenStart + 1, tokenEnd);

  if (trigger === '#') {
    const key = value.split(':', 1)[0]?.trim() ?? '';
    return {
      type: 'tagKey',
      start: tokenStart,
      end: tokenEnd,
      value,
      fullValue,
      key,
    };
  }

  return {
    type: 'mention',
    start: tokenStart,
    end: tokenEnd,
    value,
    fullValue,
  };
}

function renderDocumentSubtitle(document: DocumentSummary) {
  const parts: string[] = [];
  parts.push(`[[${document.slug}]]`);
  if (document.tags.length) {
    parts.push(document.tags.join(', '));
  }
  return parts.join(' • ');
}

function renderPromptSubtitle(prompt: PromptSummary) {
  const parts: string[] = [];
  parts.push(`[[prompt:${prompt.title}]]`);
  if (prompt.tags.length) {
    parts.push(prompt.tags.join(', '));
  }
  return parts.join(' • ');
}

export function MarkdownReferenceInput({
  value,
  onChange,
  projectId,
  maxSuggestions = MAX_DEFAULT_SUGGESTIONS,
  className,
  ...textareaProps
}: MarkdownReferenceInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [activeToken, setActiveToken] = useState<ActiveToken | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [debouncedToken, setDebouncedToken] = useState<DebouncedToken | null>(null);

  const updateToken = useCallback((text: string, caret: number | null) => {
    const token = detectReferenceToken(text, caret);
    if (token && token.type === 'tagKey' && token.key.length === 0) {
      setActiveToken(null);
      return;
    }
    if (token && token.type === 'mention' && token.value.length === 0) {
      setActiveToken(null);
      return;
    }
    setActiveToken(token);
  }, []);

  const updateTokenFromTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      setActiveToken(null);
      return;
    }
    updateToken(value, textarea.selectionStart);
  }, [updateToken, value]);

  const tokenKeyDependency = activeToken?.type === 'tagKey' ? activeToken.key : undefined;
  const tokenValueDependency = activeToken?.value;

  useEffect(() => {
    if (!activeToken) {
      setDebouncedToken(null);
      return;
    }
    const lookupValue = activeToken.type === 'tagKey' ? activeToken.key : activeToken.value.trim();

    if (!lookupValue) {
      setDebouncedToken(null);
      return;
    }

    const handle = window.setTimeout(() => {
      setDebouncedToken({
        type: activeToken.type,
        value: lookupValue,
      });
    }, 180);

    return () => {
      window.clearTimeout(handle);
    };
  }, [activeToken?.type, tokenKeyDependency, tokenValueDependency]);

  const projectScopeKey =
    projectId === undefined ? '__any__' : projectId === null ? '__global__' : projectId;

  const suggestionsQuery = useQuery({
    queryKey: [
      'markdown-reference-suggestions',
      debouncedToken?.type,
      debouncedToken?.value,
      projectScopeKey,
      maxSuggestions,
    ],
    enabled: Boolean(debouncedToken),
    queryFn: () =>
      fetchCombinedSuggestions({
        mode: debouncedToken?.type === 'tagKey' ? 'tagKey' : 'search',
        value: debouncedToken!.value,
        projectId,
        limit: maxSuggestions,
      }),
    staleTime: 15_000,
  });

  const suggestions = useMemo<SuggestionItem[]>(() => {
    if (!activeToken) {
      return [];
    }

    const items: SuggestionItem[] = [];
    if (activeToken.type === 'tagKey' && activeToken.key) {
      items.push({ kind: 'tag-group', key: activeToken.key });
    }

    // Add documents first
    if (suggestionsQuery.data?.documents?.length) {
      for (const doc of suggestionsQuery.data.documents) {
        items.push({ kind: 'document', document: doc });
      }
    }

    // Then add prompts
    if (suggestionsQuery.data?.prompts?.length) {
      for (const prompt of suggestionsQuery.data.prompts) {
        items.push({ kind: 'prompt', prompt });
      }
    }

    return items;
  }, [activeToken, suggestionsQuery.data]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [activeToken?.type, debouncedToken?.value, suggestions.length]);

  useEffect(() => {
    if (selectedIndex >= suggestions.length) {
      setSelectedIndex(Math.max(0, suggestions.length - 1));
    }
  }, [selectedIndex, suggestions.length]);

  const closePopover = useCallback(() => {
    setActiveToken(null);
    setDebouncedToken(null);
  }, []);

  const handleTextareaChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const nextValue = event.target.value;
      const caret = event.target.selectionStart;
      onChange(nextValue);
      updateToken(nextValue, caret);
    },
    [onChange, updateToken],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Escape' && activeToken) {
        event.preventDefault();
        closePopover();
        return;
      }

      if (!activeToken || !suggestions.length) {
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % suggestions.length);
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length);
        return;
      }

      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const item = suggestions[selectedIndex] ?? suggestions[0];
        if (item) {
          if (event.key === 'Tab') {
            event.stopPropagation();
          }
          handleSuggestionSelect(item);
        }
      }
    },
    [activeToken, closePopover, selectedIndex, suggestions],
  );

  const handleSuggestionSelect = useCallback(
    (item: SuggestionItem) => {
      if (!activeToken) {
        return;
      }
      let replacement: string;
      if (item.kind === 'tag-group') {
        replacement = `[[#${item.key}]]`;
      } else if (item.kind === 'prompt') {
        replacement = `[[prompt:${item.prompt.title}]]`;
      } else {
        replacement = `[[${item.document.slug}]]`;
      }

      const before = value.slice(0, activeToken.start);
      const after = value.slice(activeToken.end);
      const nextValue = `${before}${replacement}${after}`;

      const nextCaret = before.length + replacement.length;

      onChange(nextValue);
      closePopover();

      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          textareaRef.current.setSelectionRange(nextCaret, nextCaret);
        }
      });
    },
    [activeToken, closePopover, onChange, value],
  );

  const handleMouseDownSuggestion = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>, item: SuggestionItem) => {
      event.preventDefault();
      handleSuggestionSelect(item);
    },
    [handleSuggestionSelect],
  );

  const popoverOpen = Boolean(activeToken && (debouncedToken || suggestionsQuery.isLoading));

  return (
    <Popover
      open={popoverOpen}
      onOpenChange={(open) => {
        if (!open) {
          closePopover();
        }
      }}
    >
      <PopoverTrigger asChild>
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={handleTextareaChange}
          onKeyDown={handleKeyDown}
          onClick={updateTokenFromTextarea}
          onKeyUp={updateTokenFromTextarea}
          onFocus={updateTokenFromTextarea}
          onSelect={updateTokenFromTextarea}
          className={cn('font-mono', className)}
          {...textareaProps}
        />
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        className="w-[22rem] p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div className="border-b px-3 py-2 text-xs text-muted-foreground">
          {activeToken?.type === 'tagKey'
            ? activeToken.key
              ? `Add reference for #${activeToken.key}`
              : 'Type to search for tag keys'
            : activeToken?.value
              ? `Search documents and prompts for "${activeToken.value}"`
              : 'Type to search documents and prompts'}
        </div>
        <div
          className="max-h-64 overflow-y-auto overscroll-contain"
          onWheel={(e) => e.stopPropagation()}
        >
          {suggestionsQuery.isLoading ? (
            <div className="flex items-center justify-center gap-2 px-3 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading suggestions…
            </div>
          ) : suggestions.length ? (
            <div role="listbox" aria-label="Reference suggestions">
              {suggestions.map((item, index) => {
                const isActive = index === selectedIndex;
                const key =
                  item.kind === 'tag-group'
                    ? `tag:${item.key}`
                    : item.kind === 'prompt'
                      ? `prompt:${item.prompt.id}`
                      : `doc:${item.document.id}`;
                return (
                  <button
                    key={key}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    className={cn(
                      'flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors',
                      isActive ? 'bg-muted' : 'hover:bg-muted/60',
                    )}
                    onMouseDown={(event) => handleMouseDownSuggestion(event, item)}
                  >
                    {item.kind === 'tag-group' ? (
                      <Hash className="mt-0.5 h-4 w-4 flex-none text-muted-foreground" />
                    ) : item.kind === 'prompt' ? (
                      <ScrollText className="mt-0.5 h-4 w-4 flex-none text-muted-foreground" />
                    ) : (
                      <FileText className="mt-0.5 h-4 w-4 flex-none text-muted-foreground" />
                    )}
                    <div className="flex flex-col">
                      <span className="font-medium">
                        {item.kind === 'tag-group'
                          ? `All ${item.key}:*`
                          : item.kind === 'prompt'
                            ? item.prompt.title
                            : item.document.title || item.document.slug}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {item.kind === 'tag-group'
                          ? 'Insert grouped reference'
                          : item.kind === 'prompt'
                            ? renderPromptSubtitle(item.prompt)
                            : renderDocumentSubtitle(item.document)}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="px-3 py-4 text-sm text-muted-foreground">
              {suggestionsQuery.isError
                ? 'Unable to load suggestions'
                : activeToken?.type === 'tagKey'
                  ? `No documents tagged with ${activeToken.key}`
                  : 'No documents or prompts match your search'}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
