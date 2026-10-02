import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/ui/lib/utils';

/**
 * Decorative spinner. It carries no meaning of its own: pair it with a visible
 * text label and keep it `aria-hidden` so screen readers skip the animation.
 * `inline-block` keeps it on the text line inside a plain paragraph, where the
 * base styles would make an `svg` a block; inside flex layouts it changes nothing.
 */
export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2
      aria-hidden="true"
      className={cn('inline-block h-4 w-4 animate-spin motion-reduce:animate-none', className)}
    />
  );
}

export type BusyStatusProps = React.HTMLAttributes<HTMLParagraphElement>;

/**
 * Polite live region for in-progress work: `role="status"` announces the text
 * once (no interruption) while the spinner shows that work is still moving.
 */
export function BusyStatus({ className, children, ...props }: BusyStatusProps) {
  return (
    <p role="status" className={cn('inline-flex items-center gap-2', className)} {...props}>
      <Spinner />
      {children}
    </p>
  );
}
