import { useState } from 'react';
import { Button } from '@/ui/components/ui/button';
import { Copy, Check } from 'lucide-react';
import { cn } from '@/ui/lib/utils';

interface JsonViewerProps {
  data: unknown;
  className?: string;
  maxHeight?: string;
}

export function JsonViewer({ data, className, maxHeight = '400px' }: JsonViewerProps) {
  const [copied, setCopied] = useState(false);

  const jsonString = JSON.stringify(data, null, 2);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(jsonString);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <div className={cn('relative rounded-lg border bg-muted/50', className)}>
      <div className="absolute right-2 top-2 z-10">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          className="h-8 w-8 p-0"
          aria-label="Copy JSON"
        >
          {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
      <pre
        className="overflow-auto p-4 text-sm font-mono"
        style={{ maxHeight }}
        role="region"
        aria-label="JSON content"
      >
        <code>{jsonString}</code>
      </pre>
    </div>
  );
}
