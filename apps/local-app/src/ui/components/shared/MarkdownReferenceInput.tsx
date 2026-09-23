'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Textarea, type TextareaProps } from '@/ui/components/ui/textarea';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/components/ui/popover';
import { cn } from '@/ui/lib/utils';
import { Loader2, ScrollText } from 'lucide-react';

type PromptSummary = {
  id: string;
  title: string;
  tags: string[];
  projectId: string | null;
};

interface MarkdownReferenceInputProps
  extends Omit<TextareaProps, 'value' | 'onChange' | 'onKeyDown' | 'onChangeCapture'> {
  value: string;
  onChange: (value: string) => void;
  projectId?: string | null;
  maxSuggestions?: number;
}

interface ActiveToken {
  start: number;
  end: number;
  value: string;
  fullValue: string;
}

const TOKEN_BOUNDARY = /[\s\[\]\(\)\{\}"'`~!$%^&*+=|\\;,.<>/?]/;
const MAX_DEFAULT_SUGGESTIONS = 7;

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
    // Suggestions are decorative: a failed fetch yields an empty list instead
    // of blocking instruction editing.
    return [];
  }
  const data = (await response.json()) as { items: PromptSummary[] };
  return data.items ?? [];
}

function detectReferenceToken(text: string, caret: number | null): ActiveToken | null {
  if (caret === null) {
    return null;
  }

  let index = caret - 1;
  let tokenStart = -1;

  while (index >= 0) {
    const char = text[index];
    if (char === '@') {
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

  const caretIdx = caret;

  let tokenEnd = caretIdx;
  while (tokenEnd < text.length && !TOKEN_BOUNDARY.test(text[tokenEnd])) {
    if (text[tokenEnd] === '@') {
      break;
    }
    tokenEnd += 1;
  }

  return {
    start: tokenStart,
    end: tokenEnd,
    value: text.slice(tokenStart + 1, caretIdx),
    fullValue: text.slice(tokenStart + 1, tokenEnd),
  };
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
  const [debouncedValue, setDebouncedValue] = useState<string | null>(null);

  const updateToken = useCallback((text: string, caret: number | null) => {
    const token = detectReferenceToken(text, caret);
    if (token && token.value.length === 0) {
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

  const activeTokenStart = activeToken?.start ?? null;
  const activeTokenValue = activeToken?.value ?? null;

  useEffect(() => {
    if (activeTokenValue === null) {
      setDebouncedValue(null);
      return;
    }
    const lookupValue = activeTokenValue.trim();

    if (!lookupValue) {
      setDebouncedValue(null);
      return;
    }

    const handle = window.setTimeout(() => {
      setDebouncedValue(lookupValue);
    }, 180);

    return () => {
      window.clearTimeout(handle);
    };
  }, [activeTokenStart, activeTokenValue]);

  const projectScopeKey =
    projectId === undefined ? '__any__' : projectId === null ? '__global__' : projectId;

  const suggestionsQuery = useQuery({
    queryKey: ['markdown-reference-suggestions', debouncedValue, projectScopeKey, maxSuggestions],
    enabled: Boolean(debouncedValue),
    queryFn: () =>
      fetchPromptSuggestions({
        value: debouncedValue!,
        projectId,
        limit: maxSuggestions,
      }),
    staleTime: 15_000,
  });

  const suggestions = useMemo<PromptSummary[]>(() => {
    if (!activeToken) {
      return [];
    }
    return suggestionsQuery.data ?? [];
  }, [activeToken, suggestionsQuery.data]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [activeTokenStart, activeTokenValue, debouncedValue, suggestions.length]);

  useEffect(() => {
    if (selectedIndex >= suggestions.length) {
      setSelectedIndex(Math.max(0, suggestions.length - 1));
    }
  }, [selectedIndex, suggestions.length]);

  const closePopover = useCallback(() => {
    setActiveToken(null);
    setDebouncedValue(null);
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

  const handleSuggestionSelect = useCallback(
    (prompt: PromptSummary) => {
      if (!activeToken) {
        return;
      }
      const replacement = `[[prompt:${prompt.title}]]`;

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
        const prompt = suggestions[selectedIndex] ?? suggestions[0];
        if (prompt) {
          if (event.key === 'Tab') {
            event.stopPropagation();
          }
          handleSuggestionSelect(prompt);
        }
      }
    },
    [activeToken, closePopover, handleSuggestionSelect, selectedIndex, suggestions],
  );

  const handleMouseDownSuggestion = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>, prompt: PromptSummary) => {
      event.preventDefault();
      handleSuggestionSelect(prompt);
    },
    [handleSuggestionSelect],
  );

  const popoverOpen = Boolean(activeToken && (debouncedValue || suggestionsQuery.isLoading));

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
          {activeToken?.value
            ? `Search prompts for "${activeToken.value}"`
            : 'Type to search prompts'}
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
            <div role="listbox" aria-label="Prompt suggestions">
              {suggestions.map((prompt, index) => {
                const isActive = index === selectedIndex;
                return (
                  <button
                    key={`prompt:${prompt.id}`}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    className={cn(
                      'flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors',
                      isActive ? 'bg-muted' : 'hover:bg-muted/60',
                    )}
                    onMouseDown={(event) => handleMouseDownSuggestion(event, prompt)}
                  >
                    <ScrollText className="mt-0.5 h-4 w-4 flex-none text-muted-foreground" />
                    <div className="flex flex-col">
                      <span className="font-medium">{prompt.title}</span>
                      <span className="text-xs text-muted-foreground">
                        {renderPromptSubtitle(prompt)}
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
                : 'No prompts match your search'}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
