import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from '@/ui/hooks/use-toast';
import { cn } from '@/ui/lib/utils';

export interface CopyTextButtonProps {
  /** The exact text to put on the clipboard. */
  text: string;
  /** Accessible name, for example "Copy message". */
  label: string;
  className?: string;
}

const COPIED_MS = 1500;

/** Small icon button that copies `text` and shows a check mark for a short time. */
export function CopyTextButton({ text, label, className }: CopyTextButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      toast({
        title: 'Clipboard write blocked',
        description: 'Allow clipboard access, then try again.',
        variant: 'destructive',
      });
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      className={cn(
        'shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground',
        className,
      )}
      aria-label={label}
      title={label}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}
