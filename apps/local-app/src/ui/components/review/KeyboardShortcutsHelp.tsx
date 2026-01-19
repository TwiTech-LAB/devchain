import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Badge } from '@/ui/components/ui/badge';
import { Keyboard } from 'lucide-react';
import { KEYBOARD_SHORTCUTS } from '@/ui/hooks/useKeyboardShortcuts';

export interface KeyboardShortcutsHelpProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Renders a keyboard key badge
 */
function KeyBadge({ children }: { children: React.ReactNode }) {
  return (
    <Badge
      variant="outline"
      className="px-2 py-0.5 text-xs font-mono bg-muted min-w-[24px] justify-center"
    >
      {children}
    </Badge>
  );
}

/**
 * Modal dialog showing all available keyboard shortcuts
 */
export function KeyboardShortcutsHelp({ open, onOpenChange }: KeyboardShortcutsHelpProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="h-5 w-5" />
            Keyboard Shortcuts
          </DialogTitle>
          <DialogDescription className="sr-only">
            List of available keyboard shortcuts for navigating the review
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {KEYBOARD_SHORTCUTS.map((shortcut) => (
            <div key={shortcut.key} className="flex items-center justify-between gap-4">
              <span className="text-sm text-muted-foreground">{shortcut.description}</span>
              <KeyBadge>{shortcut.key}</KeyBadge>
            </div>
          ))}
        </div>
        <div className="pt-2 text-xs text-muted-foreground text-center border-t">
          Press <KeyBadge>?</KeyBadge> anytime to show this help
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default KeyboardShortcutsHelp;
