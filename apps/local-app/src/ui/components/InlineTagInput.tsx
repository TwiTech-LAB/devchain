import { useState, useMemo, useRef, useEffect } from 'react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Tag as TagIcon, X, Plus } from 'lucide-react';
import { cn } from '../lib/utils';

interface InlineTagInputProps {
  tags: string[];
  suggestions: string[];
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
  compact?: boolean;
  className?: string;
}

/**
 * InlineTagInput provides a compact tag editor for document rows
 */
export function InlineTagInput({
  tags,
  suggestions,
  onAddTag,
  onRemoveTag,
  compact = false,
  className,
}: InlineTagInputProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [input, setInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const filteredSuggestions = useMemo(() => {
    if (!input) return [];
    return suggestions
      .filter((s) => s.toLowerCase().includes(input.toLowerCase()) && !tags.includes(s))
      .slice(0, 6);
  }, [input, suggestions, tags]);

  const handleAddTag = (value: string) => {
    const trimmed = value.trim();
    if (trimmed && !tags.includes(trimmed)) {
      onAddTag(trimmed);
      setInput('');
      setShowSuggestions(false);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      if (input.trim()) {
        handleAddTag(input);
      } else {
        setIsEditing(false);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setInput('');
      setIsEditing(false);
      setShowSuggestions(false);
    } else if (event.key === 'Backspace' && !input && tags.length > 0) {
      onRemoveTag(tags[tags.length - 1]);
    }
  };

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isEditing]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsEditing(false);
        setInput('');
        setShowSuggestions(false);
      }
    };

    if (isEditing) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isEditing]);

  if (!isEditing) {
    return (
      <div className={cn('flex flex-wrap items-center gap-2', className)}>
        {tags.map((tag) => (
          <Badge key={tag} variant="outline" className={cn('gap-1', compact && 'text-xs py-0.5')}>
            <TagIcon className={cn('h-3 w-3', compact && 'h-2.5 w-2.5')} />
            {tag}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRemoveTag(tag);
              }}
              className="ml-1 rounded-full hover:bg-muted"
              aria-label={`Remove tag: ${tag}`}
            >
              <X className={cn('h-3 w-3', compact && 'h-2.5 w-2.5')} />
            </button>
          </Badge>
        ))}
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            setIsEditing(true);
          }}
          className={cn('h-6 px-2 gap-1', compact && 'h-5 px-1.5 text-xs')}
        >
          <Plus className={cn('h-3 w-3', compact && 'h-2.5 w-2.5')} />
          Add
        </Button>
      </div>
    );
  }

  return (
    <div ref={containerRef} className={cn('relative flex flex-wrap items-center gap-2', className)}>
      {tags.map((tag) => (
        <Badge key={tag} variant="secondary" className={cn('gap-1', compact && 'text-xs py-0.5')}>
          <TagIcon className={cn('h-3 w-3', compact && 'h-2.5 w-2.5')} />
          {tag}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemoveTag(tag);
            }}
            className="ml-1 rounded-full hover:bg-muted"
            aria-label={`Remove tag: ${tag}`}
          >
            <X className={cn('h-3 w-3', compact && 'h-2.5 w-2.5')} />
          </button>
        </Badge>
      ))}
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setShowSuggestions(true);
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => setShowSuggestions(true)}
          placeholder="Add tag..."
          className={cn(
            'min-w-[100px] rounded-md border border-input bg-background px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-ring',
            compact && 'min-w-[80px] px-1.5 py-0.5 text-xs',
          )}
          onClick={(e) => e.stopPropagation()}
        />
        {showSuggestions && filteredSuggestions.length > 0 && (
          <div className="absolute z-20 mt-1 w-48 rounded-md border bg-popover shadow-lg">
            {filteredSuggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleAddTag(suggestion);
                }}
                className="w-full px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
