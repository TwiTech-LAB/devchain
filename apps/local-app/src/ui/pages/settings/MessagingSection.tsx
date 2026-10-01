import { useEffect, useState } from 'react';
import { Button } from '@/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';
import { Label } from '@/ui/components/ui/label';
import { Switch } from '@/ui/components/ui/switch';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { FOLLOW_NOTE } from '@/common/follow-note';
import { useSettingsData } from './useSettingsData';

const DEFAULT_POOL_ENABLED = true;
const DEFAULT_POOL_DELAY_MS = 10000;
const MIN_POOL_DELAY_MS = 1000;
const MAX_POOL_DELAY_MS = 60000;
const DEFAULT_POOL_MAX_WAIT_MS = 30000;
const MIN_POOL_MAX_WAIT_MS = 5000;
const MAX_POOL_MAX_WAIT_MS = 120000;
const DEFAULT_POOL_MAX_MESSAGES = 10;
const MIN_POOL_MAX_MESSAGES = 1;
const MAX_POOL_MAX_MESSAGES = 50;
const DEFAULT_POOL_SEPARATOR = '\n---\n';
const DEFAULT_FOLLOW_NOTE = true;

export function MessagingSection() {
  const { settings, updateMessagePoolMutation, updateMessagingMutation } = useSettingsData();

  const [poolEnabled, setPoolEnabled] = useState(DEFAULT_POOL_ENABLED);
  const [poolDelayMs, setPoolDelayMs] = useState(DEFAULT_POOL_DELAY_MS);
  const [poolMaxWaitMs, setPoolMaxWaitMs] = useState(DEFAULT_POOL_MAX_WAIT_MS);
  const [poolMaxMessages, setPoolMaxMessages] = useState<number | ''>(DEFAULT_POOL_MAX_MESSAGES);
  const [poolSeparator, setPoolSeparator] = useState(DEFAULT_POOL_SEPARATOR);
  const [followNote, setFollowNote] = useState(DEFAULT_FOLLOW_NOTE);

  const storedPool = settings?.messagePool;
  // Sync only the pooling primitives: a settings refetch that leaves the pool
  // values unchanged (e.g. after the follow-note switch saves) must not wipe
  // unsaved pool edits.
  useEffect(() => {
    setPoolEnabled(storedPool?.enabled ?? DEFAULT_POOL_ENABLED);
    setPoolDelayMs(storedPool?.delayMs ?? DEFAULT_POOL_DELAY_MS);
    setPoolMaxWaitMs(storedPool?.maxWaitMs ?? DEFAULT_POOL_MAX_WAIT_MS);
    setPoolMaxMessages(storedPool?.maxMessages ?? DEFAULT_POOL_MAX_MESSAGES);
    setPoolSeparator(storedPool?.separator ?? DEFAULT_POOL_SEPARATOR);
  }, [
    storedPool?.enabled,
    storedPool?.delayMs,
    storedPool?.maxWaitMs,
    storedPool?.maxMessages,
    storedPool?.separator,
  ]);

  useEffect(() => {
    setFollowNote(settings?.messaging?.followNote ?? DEFAULT_FOLLOW_NOTE);
  }, [settings?.messaging?.followNote]);

  const handleFollowNoteChange = (checked: boolean) => {
    const previous = followNote;
    setFollowNote(checked);
    updateMessagingMutation.mutate(
      { followNote: checked },
      { onError: () => setFollowNote(previous) },
    );
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Message Pooling</CardTitle>
          <CardDescription>
            Configure how messages are batched before delivery to agent sessions. Pooling reduces
            context fragmentation when multiple events occur rapidly.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-6 max-w-lg">
            {/* Enable/Disable Toggle */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="pool-enabled">Enable Message Pooling</Label>
                <p className="text-xs text-muted-foreground">
                  When disabled, default-lane messages bypass batching; Delivery on Idle still waits
                </p>
              </div>
              <Switch
                id="pool-enabled"
                checked={poolEnabled}
                onCheckedChange={setPoolEnabled}
                disabled={updateMessagePoolMutation.isPending}
              />
            </div>

            {!poolEnabled && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Pooling Disabled</AlertTitle>
                <AlertDescription>
                  Default-lane messages will be delivered immediately. Delivery on Idle remains
                  queued until the target session is idle.
                </AlertDescription>
              </Alert>
            )}

            {/* Delay Input */}
            <div className="space-y-2">
              <Label htmlFor="pool-delay">Debounce Delay (seconds)</Label>
              <input
                id="pool-delay"
                type="number"
                min={MIN_POOL_DELAY_MS / 1000}
                max={MAX_POOL_DELAY_MS / 1000}
                step={1}
                className="w-24 rounded border px-3 py-2 text-sm bg-background"
                value={poolDelayMs / 1000}
                onChange={(e) => {
                  const v = e.target.value;
                  const n = Number(v);
                  if (Number.isFinite(n) && n > 0) {
                    setPoolDelayMs(n * 1000);
                  }
                }}
                disabled={!poolEnabled || updateMessagePoolMutation.isPending}
              />
              <p className="text-xs text-muted-foreground">
                Timer resets on each new message. Range: 1s - 60s
              </p>
            </div>

            {/* Max Wait Input */}
            <div className="space-y-2">
              <Label htmlFor="pool-max-wait">Maximum Wait Time (seconds)</Label>
              <input
                id="pool-max-wait"
                type="number"
                min={MIN_POOL_MAX_WAIT_MS / 1000}
                max={MAX_POOL_MAX_WAIT_MS / 1000}
                step={5}
                className="w-24 rounded border px-3 py-2 text-sm bg-background"
                value={poolMaxWaitMs / 1000}
                onChange={(e) => {
                  const v = e.target.value;
                  const n = Number(v);
                  if (Number.isFinite(n) && n > 0) {
                    setPoolMaxWaitMs(n * 1000);
                  }
                }}
                disabled={!poolEnabled || updateMessagePoolMutation.isPending}
              />
              <p className="text-xs text-muted-foreground">
                Forces flush after this time regardless of new messages. Prevents starvation.
                {poolEnabled && poolMaxWaitMs < poolDelayMs && (
                  <span className="text-destructive ml-1">(Must be ≥ debounce delay)</span>
                )}
              </p>
            </div>

            {/* Max Messages Input */}
            <div className="space-y-2">
              <Label htmlFor="pool-max-messages">Maximum Messages</Label>
              <input
                id="pool-max-messages"
                type="number"
                min={MIN_POOL_MAX_MESSAGES}
                max={MAX_POOL_MAX_MESSAGES}
                step={1}
                className="w-24 rounded border px-3 py-2 text-sm bg-background"
                value={poolMaxMessages}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === '') {
                    setPoolMaxMessages('');
                    return;
                  }
                  const n = Number(v);
                  if (Number.isFinite(n)) {
                    setPoolMaxMessages(n);
                  }
                }}
                disabled={updateMessagePoolMutation.isPending}
              />
              <p className="text-xs text-muted-foreground">
                Default-lane flush threshold and idle-lane hard capacity. Range: 1 - 50
              </p>
            </div>

            {/* Separator Input */}
            <div className="space-y-2">
              <Label htmlFor="pool-separator">Message Separator</Label>
              <input
                id="pool-separator"
                type="text"
                className="w-full rounded border px-3 py-2 text-sm bg-background font-mono"
                value={poolSeparator.replace(/\n/g, '\\n')}
                onChange={(e) => {
                  const value = e.target.value.replace(/\\n/g, '\n');
                  setPoolSeparator(value);
                }}
                placeholder="\n---\n"
                disabled={!poolEnabled || updateMessagePoolMutation.isPending}
              />
              <p className="text-xs text-muted-foreground">
                Text inserted between batched messages. Use \n for newlines.
              </p>
            </div>

            {/* Save Button */}
            <div>
              <Button
                disabled={
                  poolMaxMessages === '' ||
                  (poolEnabled && poolMaxWaitMs < poolDelayMs) ||
                  updateMessagePoolMutation.isPending
                }
                onClick={() => {
                  if (poolMaxMessages === '') return;
                  const coercedMaxMessages = Math.max(
                    MIN_POOL_MAX_MESSAGES,
                    Math.min(Number(poolMaxMessages), MAX_POOL_MAX_MESSAGES),
                  );
                  const coercedDelayMs = Math.max(
                    MIN_POOL_DELAY_MS,
                    Math.min(poolDelayMs, MAX_POOL_DELAY_MS),
                  );
                  const coercedMaxWaitMs = Math.max(
                    poolEnabled ? coercedDelayMs : MIN_POOL_MAX_WAIT_MS,
                    Math.min(poolMaxWaitMs, MAX_POOL_MAX_WAIT_MS),
                  );
                  updateMessagePoolMutation.mutate({
                    enabled: poolEnabled,
                    delayMs: coercedDelayMs,
                    maxWaitMs: coercedMaxWaitMs,
                    maxMessages: coercedMaxMessages,
                    separator: poolSeparator,
                  });
                }}
              >
                {updateMessagePoolMutation.isPending ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" /> Saving…
                  </span>
                ) : (
                  'Save'
                )}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Message Delivery</CardTitle>
          <CardDescription>
            Control the note DevChain types after delivering a message to a session.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4 max-w-lg">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="follow-note">Type a follow note after DevChain messages</Label>
                <p className="text-xs text-muted-foreground">
                  Claude Code treats a long paste as untrusted content. DevChain types this note
                  after each paste so Claude follows the message. Applies to Claude sessions only.
                </p>
              </div>
              <Switch
                id="follow-note"
                checked={followNote}
                onCheckedChange={handleFollowNoteChange}
                disabled={updateMessagingMutation.isPending}
              />
            </div>

            <div className="rounded-lg border bg-muted/30 p-4">
              <p className="text-xs text-muted-foreground mb-2">Typed note</p>
              <p className="font-mono text-sm whitespace-pre">{FOLLOW_NOTE.trim()}</p>
            </div>

            {updateMessagingMutation.isPending && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Saving settings…
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
