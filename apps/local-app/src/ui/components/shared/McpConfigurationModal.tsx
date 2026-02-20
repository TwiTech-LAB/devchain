import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Button } from '@/ui/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';
import { AlertTriangle, Copy, Check, Loader2, Terminal, RefreshCw } from 'lucide-react';
import { cn } from '@/ui/lib/utils';

export interface McpConfigurationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerId: string;
  providerName: string;
  /** Project root path (used for provider-specific MCP configuration like Claude settings) */
  projectPath?: string;
  /** Called when configuration succeeds */
  onConfigured?: () => void;
  /** Called to verify configuration (e.g., refetch preflight) */
  onVerify?: () => Promise<boolean>;
}

// Get the MCP endpoint URL based on current origin
function getMcpEndpointUrl(): string {
  // In dev, UI runs on Vite (5175) while API/MCP runs on 3000.
  const port = window.location.port === '5175' ? '3000' : window.location.port || '3000';
  return `http://127.0.0.1:${port}/mcp`;
}

// Get the manual configuration command for a provider
function getManualCommand(providerName: string, endpoint: string): string {
  const name = providerName.toLowerCase();
  const alias = 'devchain';

  switch (name) {
    case 'claude':
      return `claude mcp add --transport http ${alias} ${endpoint}`;
    case 'codex':
      return `codex mcp add --url ${endpoint} ${alias}`;
    case 'gemini':
      return `gemini mcp add -t http ${alias} ${endpoint}`;
    default:
      return `# Manual MCP configuration for ${providerName}`;
  }
}

/**
 * Modal for manual MCP configuration after auto-config fails.
 * Shows manual command with copy button and verify option.
 */
export function McpConfigurationModal({
  open,
  onOpenChange,
  providerName,
  onConfigured,
  onVerify,
}: McpConfigurationModalProps) {
  const [isVerifying, setIsVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const endpoint = getMcpEndpointUrl();
  const manualCommand = getManualCommand(providerName, endpoint);

  const handleVerify = async () => {
    if (!onVerify) return;

    setIsVerifying(true);
    setError(null);

    try {
      const success = await onVerify();
      if (success) {
        onConfigured?.();
        onOpenChange(false);
      } else {
        setError('MCP configuration not detected. Please ensure the command was run successfully.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to verify configuration');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(manualCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = manualCommand;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/10">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
            </div>
            <DialogTitle>Manual MCP Configuration Required</DialogTitle>
          </div>
          <DialogDescription className="text-left">
            Auto-configuration failed for <span className="font-medium">{providerName}</span>.
            Please run the command below manually to configure MCP.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Error alert */}
          {error && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Configuration Error</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Manual Command */}
          <div className="rounded-lg border p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4" />
              <h4 className="font-medium">Run in Terminal</h4>
            </div>
            <div className="relative">
              <pre className="rounded-md bg-muted p-3 text-xs overflow-x-auto">
                <code>{manualCommand}</code>
              </pre>
              <Button
                size="sm"
                variant="ghost"
                className={cn('absolute right-1 top-1 h-7 w-7 p-0', copied && 'text-green-500')}
                onClick={handleCopy}
                title={copied ? 'Copied!' : 'Copy to clipboard'}
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
            {onVerify && (
              <Button
                variant="outline"
                onClick={handleVerify}
                disabled={isVerifying}
                className="w-full"
              >
                {isVerifying ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Verifying...
                  </>
                ) : (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Verify Configuration
                  </>
                )}
              </Button>
            )}
          </div>

          {/* Additional info */}
          <Alert variant="default" className="border-muted bg-muted/50">
            <AlertDescription className="text-sm">
              MCP (Model Context Protocol) enables {providerName} to communicate with DevChain for
              task coordination and context sharing.
            </AlertDescription>
          </Alert>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
