import { AlertTriangle } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/components/ui/alert-dialog';

interface ProviderMismatchWarningModalProps {
  open: boolean;
  warnings: Array<{
    type: 'provider_mismatch';
    originalProvider: string;
    substituteProvider: string;
    agentNames: string[];
  }>;
  onNavigate: (destination: '/chat' | '/board') => void;
}

export function ProviderMismatchWarningModal({
  open,
  warnings,
  onNavigate,
}: ProviderMismatchWarningModalProps) {
  return (
    <AlertDialog open={open} onOpenChange={() => {}}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-yellow-500" />
            <AlertDialogTitle>Provider Mismatch Warning</AlertDialogTitle>
          </div>
          <AlertDialogDescription>
            Some agents were created with substitute providers because the original providers are
            not installed.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3">
          {warnings.map((warning) => (
            <div
              key={`${warning.originalProvider}-${warning.substituteProvider}-${warning.agentNames.join('|')}`}
              className="rounded-md border border-border bg-muted/30 p-3 text-sm"
            >
              <div className="font-medium">
                <span className="text-destructive">Missing: {warning.originalProvider}</span>
                <span className="mx-2 text-muted-foreground">→</span>
                <span>{warning.substituteProvider}</span>
              </div>
              <div className="mt-1 text-muted-foreground">
                Affected agents: {warning.agentNames.join(', ')}
              </div>
            </div>
          ))}
        </div>

        <p className="text-sm text-muted-foreground">
          You can configure the correct provider for each agent from the Chat page.
        </p>

        <AlertDialogFooter>
          <Button variant="outline" onClick={() => onNavigate('/board')}>
            Continue to Board
          </Button>
          <Button onClick={() => onNavigate('/chat')}>Go to Chat</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
