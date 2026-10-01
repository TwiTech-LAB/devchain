import { useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import {
  DEFAULT_FILE_SYNC_IGNORES,
  IGNORE_PATTERNS_MAX,
  IGNORE_PATTERN_MAX_LENGTH,
} from '@/modules/file-sync/file-sync.dto';
import type { IgnoreDraft } from './connect-ignores';

/** The project's ignore patterns as removable chips. Edits stay local until Connect. */
export function IgnoreListEditor({
  list,
  disabled,
  onChange,
}: {
  list: readonly string[];
  disabled: boolean;
  onChange: (draft: IgnoreDraft) => void;
}) {
  const [pattern, setPattern] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const add = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = pattern.trim();
    if (!trimmed) return;
    if (list.includes(trimmed)) return setProblem(`${trimmed} is already in the list.`);
    if (trimmed.length > IGNORE_PATTERN_MAX_LENGTH) {
      return setProblem(`A pattern can have at most ${IGNORE_PATTERN_MAX_LENGTH} characters.`);
    }
    if (list.length >= IGNORE_PATTERNS_MAX) {
      return setProblem(`The list can hold at most ${IGNORE_PATTERNS_MAX} patterns.`);
    }
    setProblem(null);
    setPattern('');
    onChange({ list: [...list, trimmed], restored: false });
  };

  return (
    <section aria-label="Files that do not sync" className="space-y-3 text-sm">
      <div className="space-y-1">
        <h3 className="font-medium">Files that do not sync</h3>
        <p className="text-muted-foreground">
          .env files and other secrets sync unless you add a rule. Git history comes from the VM to
          this PC only.
        </p>
      </div>
      {list.length === 0 ? (
        <p className="text-muted-foreground">Every file syncs.</p>
      ) : (
        <ul aria-label="Ignore patterns" className="flex flex-wrap gap-1.5">
          {list.map((item) => (
            <li key={item}>
              <Badge variant="secondary" className="gap-1 pr-1 font-mono font-normal">
                <span className="break-all">{item}</span>
                <button
                  type="button"
                  aria-label={`Remove ${item}`}
                  disabled={disabled}
                  onClick={() =>
                    onChange({ list: list.filter((kept) => kept !== item), restored: false })
                  }
                  className="rounded-sm p-0.5 hover:bg-background/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  <X aria-hidden="true" className="h-3 w-3" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="flex flex-wrap items-end gap-2">
        <div className="min-w-[12rem] flex-1 space-y-1.5">
          <Label htmlFor="connect-ignore-pattern">Add a pattern</Label>
          <Input
            id="connect-ignore-pattern"
            value={pattern}
            placeholder="(?d)tmp or *.log"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            aria-invalid={problem ? true : undefined}
            onChange={(event) => {
              setPattern(event.target.value);
              setProblem(null);
            }}
            className="font-mono"
          />
        </div>
        <Button type="submit" variant="outline" disabled={disabled || pattern.trim() === ''}>
          Add
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            setProblem(null);
            onChange({ list: [...DEFAULT_FILE_SYNC_IGNORES], restored: true });
          }}
        >
          Restore defaults
        </Button>
      </form>
      {problem && (
        <p role="alert" className="text-destructive">
          {problem}
        </p>
      )}
    </section>
  );
}
