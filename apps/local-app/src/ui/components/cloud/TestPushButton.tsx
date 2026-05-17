import React from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button } from '../ui/button';

interface TestPushResult {
  sent: number;
  failed: number;
}

interface TestPushButtonProps {
  deviceId?: string;
  deviceLabel?: string;
}

export function TestPushButton({ deviceId, deviceLabel }: TestPushButtonProps) {
  const [result, setResult] = React.useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (): Promise<TestPushResult> => {
      const res = await fetch('/api/cloud/preferences/test-push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deviceId ? { deviceId } : {}),
      });
      if (!res.ok) throw new Error(`test-push:${res.status}`);
      return res.json();
    },
    onSuccess: (data) => {
      if (data.sent === 0 && data.failed === 0) {
        setResult(
          deviceId
            ? 'This device is no longer registered.'
            : 'No devices registered. Sign in to the DevChain mobile app first.',
        );
      } else if (data.failed === 0) {
        setResult(
          deviceLabel
            ? `Test push sent to ${deviceLabel}.`
            : `Test push sent to ${data.sent} device${data.sent === 1 ? '' : 's'}.`,
        );
      } else {
        setResult(
          deviceLabel
            ? `${deviceLabel}: sent ${data.sent}. Failed: ${data.failed}.`
            : `Sent: ${data.sent}. Failed: ${data.failed}.`,
        );
      }
    },
    onError: () =>
      setResult(
        deviceLabel
          ? `Test push to ${deviceLabel} failed. Check your connection.`
          : 'Test push failed. Check your connection.',
      ),
  });

  return (
    <div className="space-y-2">
      <Button
        size="sm"
        variant={deviceId ? 'outline' : 'default'}
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
      >
        {mutation.isPending ? 'Sending...' : 'Send test push'}
      </Button>
      {result && <p className="text-xs text-muted-foreground">{result}</p>}
    </div>
  );
}
