import { Pencil } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { SessionTreeNode } from '@/ui/lib/sessions';
import { cn } from '@/ui/lib/utils';

/** Accessible name of the inline rename input. The Sessions modal keeps Escape for it. */
export const SESSION_NAME_INPUT_LABEL = 'Session name';

export function formatRelativeTime(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/**
 * The name of a record with inline rename. Escape in the input cancels the rename; a parent
 * dialog or popover keeps Escape for it by checking {@link SESSION_NAME_INPUT_LABEL}.
 */
export function SessionNameEditor({
  node,
  label,
  title,
  renamable = true,
  renamePending,
  onRename,
}: {
  node: SessionTreeNode;
  label: string;
  title: string;
  renamable?: boolean;
  renamePending: boolean;
  onRename: (node: SessionTreeNode, name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const renameCancelled = useRef(false);
  const labelClass = cn('truncate', node.kind === 'save_point' && 'text-status-info');

  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);

  if (!renamable) {
    return (
      <span title={title} className="flex min-w-0 font-mono text-xs text-foreground">
        <span className={labelClass}>{label}</span>
      </span>
    );
  }
  if (editing) {
    return (
      <input
        ref={input}
        aria-label={SESSION_NAME_INPUT_LABEL}
        maxLength={120}
        className="h-6 w-full min-w-0 rounded border border-border bg-background px-1.5 font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            renameCancelled.current = true;
            setEditing(false);
          }
        }}
        onBlur={() => {
          if (!renameCancelled.current) onRename(node, draft);
          setEditing(false);
        }}
      />
    );
  }
  return (
    <button
      type="button"
      title={title}
      className="flex min-w-0 items-center gap-1 font-mono text-xs text-foreground hover:text-primary"
      disabled={renamePending}
      onClick={() => {
        renameCancelled.current = false;
        setDraft(node.name ?? '');
        setEditing(true);
      }}
    >
      <span className={labelClass}>{label}</span>
      <Pencil aria-hidden="true" className="h-3 w-3 shrink-0 text-muted-foreground" />
    </button>
  );
}
