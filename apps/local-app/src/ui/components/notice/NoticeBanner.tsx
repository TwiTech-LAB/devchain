import { useState, type ComponentProps, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Alert, AlertDescription } from '@/ui/components/ui/alert';
import { Button } from '@/ui/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/components/ui/collapsible';

export interface NoticeBannerProps {
  tone: NonNullable<ComponentProps<typeof Alert>['variant']>;
  icon?: ReactNode;
  message: ReactNode;
  details?: ReactNode;
  actions?: { label: string; onSelect: () => void }[];
  onClose: () => void;
  closeLabel: string;
}

export function NoticeBanner({
  tone,
  icon,
  message,
  details,
  actions,
  onClose,
  closeLabel,
}: NoticeBannerProps) {
  const [open, setOpen] = useState(false);

  return (
    <Alert variant={tone} role="status">
      {icon}
      <AlertDescription className="pr-10">
        <Collapsible open={open} onOpenChange={setOpen}>
          <div>{message}</div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {details != null && (
              <CollapsibleTrigger asChild>
                <Button type="button" variant="outline" size="sm">
                  {open ? 'Hide' : 'Show'}
                </Button>
              </CollapsibleTrigger>
            )}
            {actions?.map(({ label, onSelect }) => (
              <Button key={label} type="button" variant="outline" size="sm" onClick={onSelect}>
                {label}
              </Button>
            ))}
          </div>
          {details != null && <CollapsibleContent className="mt-3">{details}</CollapsibleContent>}
        </Collapsible>
      </AlertDescription>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-2 top-2"
        aria-label={closeLabel}
        onClick={onClose}
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </Button>
    </Alert>
  );
}
