import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { Button } from '@/ui/components/ui/button';
import { Badge } from '@/ui/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';
import { Label } from '@/ui/components/ui/label';
import { Textarea } from '@/ui/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { Switch } from '@/ui/components/ui/switch';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  AlertCircle,
  RefreshCw,
  Loader2,
} from 'lucide-react';
import { fetchPreflightChecks } from '@/ui/lib/preflight';
import { useToast } from '@/ui/hooks/use-toast';
import {
  DEFAULT_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_SCROLLBACK,
} from '@/common/constants/terminal';

interface SettingsResponse {
  claudeBinaryPath?: string;
  codexBinaryPath?: string;
  dbPath?: string;
  initialSessionPromptId?: string | null;
  initialSessionPromptIds?: Record<string, string | null>;
  events?: {
    epicAssigned?: {
      template?: string | null;
    };
  };
  activity?: {
    idleTimeoutMs?: number;
  };
  terminal?: {
    scrollbackLines?: number;
    seedingMaxBytes?: number;
    inputMode?: 'form' | 'tty';
  };
  messagePool?: {
    enabled?: boolean;
    delayMs?: number;
    maxWaitMs?: number;
    maxMessages?: number;
    separator?: string;
  };
}

interface PromptSummary {
  id: string;
  title: string;
}

interface PromptsResponse {
  items: PromptSummary[];
}

// Message Pool defaults
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

async function fetchSettings(): Promise<SettingsResponse> {
  const res = await fetch('/api/settings');
  if (!res.ok) throw new Error('Failed to fetch settings');
  return res.json();
}

async function fetchPrompts(projectId: string): Promise<PromptsResponse> {
  const res = await fetch(`/api/prompts?projectId=${encodeURIComponent(projectId)}`);
  if (!res.ok) throw new Error('Failed to fetch prompts');
  return res.json();
}

async function updateSettingsRequest(
  data: Partial<SettingsResponse> & { projectId?: string },
): Promise<SettingsResponse> {
  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to update settings');
  return res.json();
}

const DEFAULT_EPIC_ASSIGNED_TEMPLATE =
  '[Epic Assignment]\n{epic_title} is now assigned to {agent_name} in {project_name}. (Epic ID: {epic_id})';
const DEFAULT_TERMINAL_SEED_MAX_BYTES = 1024 * 1024;
const MIN_TERMINAL_SEED_MAX_BYTES = 64 * 1024;
const MAX_TERMINAL_SEED_MAX_BYTES = 4 * 1024 * 1024;

const EPIC_ASSIGNED_PLACEHOLDERS = [
  { token: '{epic_id}', description: 'Epic UUID' },
  { token: '{agent_name}', description: 'Agent display name' },
  { token: '{epic_title}', description: 'Epic title' },
  { token: '{project_name}', description: 'Project name' },
];

function getStatusIcon(status: 'pass' | 'fail' | 'warn') {
  switch (status) {
    case 'pass':
      return <CheckCircle2 className="h-5 w-5 text-green-600" />;
    case 'fail':
      return <XCircle className="h-5 w-5 text-destructive" />;
    case 'warn':
      return <AlertTriangle className="h-5 w-5 text-yellow-600" />;
    default:
      return null;
  }
}

export function SettingsPage() {
  const { selectedProject } = useSelectedProject();
  const projectPath = selectedProject?.rootPath;
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const {
    data: preflightResult,
    refetch: refetchPreflight,
    isLoading: preflightLoading,
    isRefetching,
  } = useQuery({
    queryKey: ['preflight', projectPath ?? 'global'],
    queryFn: () => fetchPreflightChecks(projectPath),
    refetchInterval: 60000, // Refresh every 60 seconds (cached)
    staleTime: 60000,
  });

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
  });

  const { data: promptsData, isLoading: promptsLoading } = useQuery({
    queryKey: ['prompts', selectedProject?.id ?? null],
    queryFn: () => fetchPrompts(selectedProject?.id as string),
    enabled: !!selectedProject?.id,
  });

  const updateSettingsMutation = useMutation({
    mutationFn: ({
      initialSessionPromptId,
      projectId,
    }: {
      initialSessionPromptId: string | null;
      projectId?: string;
    }) => updateSettingsRequest({ initialSessionPromptId, projectId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast({
        title: 'Initial session prompt updated',
        description: 'New sessions will start with the selected prompt.',
      });
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Failed to update settings';
      toast({
        title: 'Update failed',
        description: message,
        variant: 'destructive',
      });
    },
  });

  const selectedPromptId =
    (selectedProject?.id && settings?.initialSessionPromptIds?.[selectedProject.id]) ?? null;
  const selectValue = selectedPromptId ?? '__none__';
  const currentPrompt = selectedPromptId
    ? promptsData?.items?.find((prompt) => prompt.id === selectedPromptId)
    : undefined;
  const promptCount = promptsData?.items?.length ?? 0;
  const disablePromptSelect =
    !settings || promptsLoading || updateSettingsMutation.isPending || !selectedProject?.id;

  const serverEpicTemplate = settings?.events?.epicAssigned?.template ?? '';
  const [idleTimeoutSec, setIdleTimeoutSec] = useState<number | ''>('');
  const [epicTemplateDraft, setEpicTemplateDraft] = useState('');
  const [scrollbackLines, setScrollbackLines] = useState<number | ''>('');
  const [seedMaxKb, setSeedMaxKb] = useState<number | ''>('');
  const [terminalInputMode, setTerminalInputMode] = useState<'form' | 'tty'>('form');

  // Message Pool state
  const [poolEnabled, setPoolEnabled] = useState(DEFAULT_POOL_ENABLED);
  const [poolDelayMs, setPoolDelayMs] = useState(DEFAULT_POOL_DELAY_MS);
  const [poolMaxWaitMs, setPoolMaxWaitMs] = useState(DEFAULT_POOL_MAX_WAIT_MS);
  const [poolMaxMessages, setPoolMaxMessages] = useState<number | ''>(DEFAULT_POOL_MAX_MESSAGES);
  const [poolSeparator, setPoolSeparator] = useState(DEFAULT_POOL_SEPARATOR);

  useEffect(() => {
    setEpicTemplateDraft(serverEpicTemplate);
  }, [serverEpicTemplate]);

  // Seed idle timeout with backend or default (30s) when settings load
  useEffect(() => {
    const ms = settings?.activity?.idleTimeoutMs ?? 30000;
    setIdleTimeoutSec(Math.floor(ms / 1000));
  }, [settings]);

  useEffect(() => {
    if (!settings) {
      return;
    }
    const lines = settings.terminal?.scrollbackLines ?? DEFAULT_TERMINAL_SCROLLBACK;
    setScrollbackLines(lines);
    const maxBytes = settings.terminal?.seedingMaxBytes ?? DEFAULT_TERMINAL_SEED_MAX_BYTES;
    setSeedMaxKb(Math.round(maxBytes / 1024));
    setTerminalInputMode(settings.terminal?.inputMode ?? 'form');
  }, [settings]);

  // Initialize message pool settings from backend
  useEffect(() => {
    if (!settings) return;
    setPoolEnabled(settings.messagePool?.enabled ?? DEFAULT_POOL_ENABLED);
    setPoolDelayMs(settings.messagePool?.delayMs ?? DEFAULT_POOL_DELAY_MS);
    setPoolMaxWaitMs(settings.messagePool?.maxWaitMs ?? DEFAULT_POOL_MAX_WAIT_MS);
    setPoolMaxMessages(settings.messagePool?.maxMessages ?? DEFAULT_POOL_MAX_MESSAGES);
    setPoolSeparator(settings.messagePool?.separator ?? DEFAULT_POOL_SEPARATOR);
  }, [settings]);

  const handleInitialPromptChange = (value: string) => {
    const normalized = value === '__none__' ? null : value;
    if (normalized === selectedPromptId) {
      return;
    }
    updateSettingsMutation.mutate({
      initialSessionPromptId: normalized,
      projectId: selectedProject?.id,
    });
  };

  const updateEpicTemplateMutation = useMutation({
    mutationFn: ({ template }: { template: string }) =>
      updateSettingsRequest({
        events: {
          epicAssigned: { template },
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast({
        title: 'Epic assignment message updated',
        description: 'Agents will see the new message on the next assignment.',
      });
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Failed to update template';
      toast({
        title: 'Update failed',
        description: message,
        variant: 'destructive',
      });
    },
  });

  const epicTemplateDirty = epicTemplateDraft !== serverEpicTemplate;

  const updateIdleTimeoutMutation = useMutation({
    mutationFn: ({ idleTimeoutMs }: { idleTimeoutMs: number }) =>
      updateSettingsRequest({ activity: { idleTimeoutMs } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast({ title: 'Activity idle timeout updated' });
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Failed to update setting';
      toast({ title: 'Update failed', description: message, variant: 'destructive' });
    },
  });

  const updateTerminalSettingsMutation = useMutation({
    mutationFn: ({
      scrollbackLines,
      seedingMaxBytes,
      inputMode,
    }: {
      scrollbackLines: number;
      seedingMaxBytes: number;
      inputMode?: 'form' | 'tty';
    }) =>
      updateSettingsRequest({
        terminal: {
          scrollbackLines,
          seedingMaxBytes,
          inputMode,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast({ title: 'Terminal settings updated' });
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Failed to update terminal settings';
      toast({ title: 'Update failed', description: message, variant: 'destructive' });
    },
  });

  const updateMessagePoolMutation = useMutation({
    mutationFn: ({
      enabled,
      delayMs,
      maxWaitMs,
      maxMessages,
      separator,
    }: {
      enabled: boolean;
      delayMs: number;
      maxWaitMs: number;
      maxMessages: number;
      separator: string;
    }) =>
      updateSettingsRequest({
        messagePool: {
          enabled,
          delayMs,
          maxWaitMs,
          maxMessages,
          separator,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast({ title: 'Message pool settings updated' });
    },
    onError: (error: unknown) => {
      const message =
        error instanceof Error ? error.message : 'Failed to update message pool settings';
      toast({ title: 'Update failed', description: message, variant: 'destructive' });
    },
  });

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-muted-foreground mt-2">
          Configure system settings and provider binaries
        </p>
      </div>

      {/* Initial Session Prompt */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Initial Session Prompt</CardTitle>
          <CardDescription>
            Choose which prompt is pasted into new sessions before the agent begins.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="initial-session-prompt">Initial prompt</Label>
              <Select
                value={selectValue}
                onValueChange={handleInitialPromptChange}
                disabled={disablePromptSelect}
              >
                <SelectTrigger id="initial-session-prompt">
                  <SelectValue
                    placeholder={promptsLoading ? 'Loading prompts…' : 'Select prompt'}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None (use default message)</SelectItem>
                  {promptsData?.items?.map((prompt) => (
                    <SelectItem key={prompt.id} value={prompt.id}>
                      {prompt.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {promptsLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading prompts…
              </div>
            )}

            {updateSettingsMutation.isPending && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Saving selection…
              </div>
            )}

            {!promptsLoading && promptCount === 0 && (
              <p className="text-sm text-muted-foreground">
                No prompts available yet. Create one on the{' '}
                <a href="/prompts" className="font-semibold underline hover:text-primary">
                  Prompts
                </a>{' '}
                page.
              </p>
            )}

            {!promptsLoading && selectedPromptId && currentPrompt && (
              <p className="text-sm text-muted-foreground">
                Selected prompt:{' '}
                <span className="font-semibold text-foreground">{currentPrompt.title}</span>
              </p>
            )}

            {!promptsLoading && selectedPromptId && !currentPrompt && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Prompt missing</AlertTitle>
                <AlertDescription>
                  The previously selected prompt could not be found. Pick another prompt to ensure
                  sessions start with the right instructions.
                </AlertDescription>
              </Alert>
            )}

            {!promptsLoading && !selectedPromptId && (
              <p className="text-sm text-muted-foreground">
                Using the default built-in message until a prompt is selected.
              </p>
            )}

            <p className="text-xs text-muted-foreground">
              Supported variables: <code className="font-mono text-xs">{`{agent_name}`}</code>,{' '}
              <code className="font-mono text-xs">{`{project_name}`}</code>,{' '}
              <code className="font-mono text-xs">{`{epic_title}`}</code>,{' '}
              <code className="font-mono text-xs">{`{provider_name}`}</code>,{' '}
              <code className="font-mono text-xs">{`{profile_name}`}</code>,{' '}
              <code className="font-mono text-xs">{`{session_id}`}</code>,{' '}
              <code className="font-mono text-xs">{`{session_id_short}`}</code>
            </p>

            <p className="text-xs text-muted-foreground">
              Need to edit the prompt content? Visit the{' '}
              <a href="/prompts" className="font-semibold underline hover:text-primary">
                Prompts
              </a>{' '}
              page.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Terminal Streaming */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Terminal Settings</CardTitle>
          <CardDescription>
            Configure terminal input mode and scrollback behavior. Chat Mode is now the default
            terminal engine, using tmux-based history seeding.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4 max-w-md">
            <div className="space-y-2">
              <Label htmlFor="terminal-input-mode">Terminal input mode</Label>
              <Select
                value={terminalInputMode}
                onValueChange={(value) => setTerminalInputMode((value as 'form' | 'tty') || 'form')}
                disabled={updateTerminalSettingsMutation.isPending}
              >
                <SelectTrigger id="terminal-input-mode" className="w-72">
                  <SelectValue placeholder="Select input mode" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="form">Form input (simple command entry)</SelectItem>
                  <SelectItem value="tty">TTY input (direct terminal control)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {terminalInputMode === 'form'
                  ? 'Form mode: Type commands in a text field and press Send. Best for simple command execution.'
                  : 'TTY mode: Direct keyboard input to terminal. Enables vim, tab completion, Ctrl+C, etc.'}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="terminal-scrollback">Scrollback lines</Label>
              <input
                id="terminal-scrollback"
                type="number"
                min={MIN_TERMINAL_SCROLLBACK}
                max={MAX_TERMINAL_SCROLLBACK}
                step={100}
                className="w-40 rounded border px-3 py-2 text-sm bg-background"
                value={scrollbackLines}
                onChange={(event) => {
                  const { value } = event.target;
                  if (value === '') {
                    setScrollbackLines('');
                    return;
                  }
                  const parsed = Number(value);
                  if (Number.isFinite(parsed)) {
                    setScrollbackLines(parsed);
                  }
                }}
                disabled={updateTerminalSettingsMutation.isPending}
              />
              <p className="text-xs text-muted-foreground">
                Controls how many lines the server emulator retains (min {MIN_TERMINAL_SCROLLBACK},
                max {MAX_TERMINAL_SCROLLBACK}).
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="terminal-seed-max">Seed snapshot cap (KB)</Label>
              <input
                id="terminal-seed-max"
                type="number"
                min={Math.floor(MIN_TERMINAL_SEED_MAX_BYTES / 1024)}
                max={Math.floor(MAX_TERMINAL_SEED_MAX_BYTES / 1024)}
                step={64}
                className="w-40 rounded border px-3 py-2 text-sm bg-background"
                value={seedMaxKb}
                onChange={(event) => {
                  const { value } = event.target;
                  if (value === '') {
                    setSeedMaxKb('');
                    return;
                  }
                  const parsed = Number(value);
                  if (Number.isFinite(parsed)) {
                    setSeedMaxKb(parsed);
                  }
                }}
                disabled={updateTerminalSettingsMutation.isPending}
              />
              <p className="text-xs text-muted-foreground">
                Caps the initial ANSI snapshot size (min {MIN_TERMINAL_SEED_MAX_BYTES / 1024}KB, max{' '}
                {MAX_TERMINAL_SEED_MAX_BYTES / 1024}KB).
              </p>
            </div>
            <div>
              <Button
                disabled={
                  scrollbackLines === '' ||
                  seedMaxKb === '' ||
                  updateTerminalSettingsMutation.isPending
                }
                onClick={() => {
                  if (scrollbackLines === '' || seedMaxKb === '') return;
                  const coercedLines = Math.round(
                    Math.max(
                      MIN_TERMINAL_SCROLLBACK,
                      Math.min(Number(scrollbackLines), MAX_TERMINAL_SCROLLBACK),
                    ),
                  );
                  const coercedSeedKb = Math.round(
                    Math.max(
                      MIN_TERMINAL_SEED_MAX_BYTES / 1024,
                      Math.min(Number(seedMaxKb), MAX_TERMINAL_SEED_MAX_BYTES / 1024),
                    ),
                  );
                  const coercedSeedBytes = coercedSeedKb * 1024;
                  updateTerminalSettingsMutation.mutate({
                    scrollbackLines: coercedLines,
                    seedingMaxBytes: coercedSeedBytes,
                    inputMode: terminalInputMode,
                  });
                }}
              >
                {updateTerminalSettingsMutation.isPending ? (
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

      {/* Terminal Activity */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Terminal Activity</CardTitle>
          <CardDescription>Configure Busy/Idle tracking for sessions.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4 max-w-md">
            <div className="space-y-2">
              <Label htmlFor="idle-timeout">Idle timeout (seconds)</Label>
              <input
                id="idle-timeout"
                type="number"
                min={1}
                step={1}
                className="w-40 rounded border px-3 py-2 text-sm bg-background"
                value={idleTimeoutSec}
                onChange={(e) => {
                  const v = e.target.value;
                  const n = Number(v);
                  setIdleTimeoutSec(Number.isFinite(n) && n > 0 ? n : '');
                }}
              />
              <p className="text-xs text-muted-foreground">
                After this period without terminal output, sessions switch to Idle.
              </p>
            </div>
            <div>
              <Button
                disabled={idleTimeoutSec === '' || updateIdleTimeoutMutation.isPending}
                onClick={() => {
                  if (idleTimeoutSec === '') return;
                  const ms = Math.max(1, idleTimeoutSec) * 1000;
                  updateIdleTimeoutMutation.mutate({ idleTimeoutMs: ms });
                }}
              >
                {updateIdleTimeoutMutation.isPending ? (
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

      {/* Message Pool Settings */}
      <Card className="mb-6">
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
                  When disabled, all messages are delivered immediately
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
                  Messages will be delivered immediately. This may cause context fragmentation when
                  multiple events occur rapidly.
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
                {poolMaxWaitMs < poolDelayMs && (
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
                disabled={!poolEnabled || updateMessagePoolMutation.isPending}
              />
              <p className="text-xs text-muted-foreground">
                Forces flush when this many messages are queued. Range: 1 - 50
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
                  poolMaxWaitMs < poolDelayMs ||
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
                    coercedDelayMs, // Ensure >= delayMs
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

      {/* Events Templates */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Events</CardTitle>
          <CardDescription>Customize agent notifications triggered by events.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="epic-assigned-template">Epic Assigned message</Label>
              <Textarea
                id="epic-assigned-template"
                value={epicTemplateDraft}
                onChange={(event) => setEpicTemplateDraft(event.target.value)}
                placeholder={DEFAULT_EPIC_ASSIGNED_TEMPLATE}
                rows={5}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Leave blank to use the default message. Supports the placeholders below.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Button
                onClick={() => updateEpicTemplateMutation.mutate({ template: epicTemplateDraft })}
                disabled={!epicTemplateDirty || updateEpicTemplateMutation.isPending}
              >
                {updateEpicTemplateMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Saving…
                  </>
                ) : (
                  'Save'
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setEpicTemplateDraft(DEFAULT_EPIC_ASSIGNED_TEMPLATE)}
                disabled={updateEpicTemplateMutation.isPending}
              >
                Reset to default
              </Button>
            </div>

            <div className="rounded-lg border bg-muted/30 p-4">
              <p className="text-sm font-semibold mb-2">Available placeholders</p>
              <ul className="space-y-1 text-sm text-muted-foreground">
                {EPIC_ASSIGNED_PLACEHOLDERS.map(({ token, description }) => (
                  <li key={token}>
                    <code className="font-mono text-xs mr-2">{token}</code>
                    {description}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Preflight Checks */}
      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>System Preflight Checks</CardTitle>
              <CardDescription>
                Verify that all required dependencies and configurations are correct
              </CardDescription>
              {selectedProject && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Target project:{' '}
                  <span className="font-semibold text-foreground">{selectedProject.name}</span>
                  <span className="ml-2 font-mono text-[11px] text-muted-foreground/80">
                    {selectedProject.rootPath}
                  </span>
                </p>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetchPreflight()}
              disabled={isRefetching}
            >
              {isRefetching ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {preflightLoading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <span className="ml-2 text-muted-foreground">Running preflight checks...</span>
            </div>
          )}

          {preflightResult && (
            <div className="space-y-4">
              {/* Overall Status */}
              <Alert variant={preflightResult.overall === 'fail' ? 'destructive' : 'default'}>
                {getStatusIcon(preflightResult.overall)}
                <AlertTitle>Overall Status: {preflightResult.overall.toUpperCase()}</AlertTitle>
                <AlertDescription>
                  {preflightResult.overall === 'pass' && 'All systems operational'}
                  {preflightResult.overall === 'warn' && 'Some checks have warnings'}
                  {preflightResult.overall === 'fail' &&
                    'Some checks failed. Session launch will be blocked.'}
                </AlertDescription>
              </Alert>

              {/* Individual Checks */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  System Checks
                </h3>
                {preflightResult.checks.map((check) => (
                  <Card
                    key={check.name}
                    className={
                      check.status === 'fail'
                        ? 'border-destructive'
                        : check.status === 'warn'
                          ? 'border-yellow-600'
                          : 'border-green-600'
                    }
                  >
                    <CardContent className="pt-4">
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5">{getStatusIcon(check.status)}</div>
                        <div className="flex-1">
                          <h4 className="font-semibold mb-1">{check.name}</h4>
                          <p className="text-sm text-muted-foreground mb-2">{check.message}</p>
                          {check.details && (
                            <div className="text-xs bg-muted p-2 rounded font-mono">
                              {check.details}
                            </div>
                          )}
                          {check.remediation && (
                            <div className="mt-2 text-xs text-muted-foreground">
                              <strong>How to fix:</strong> {check.remediation}
                            </div>
                          )}
                        </div>
                        <Badge
                          variant={
                            check.status === 'pass'
                              ? 'default'
                              : check.status === 'fail'
                                ? 'destructive'
                                : 'secondary'
                          }
                        >
                          {check.status.toUpperCase()}
                        </Badge>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Provider Checks */}
              {preflightResult.providers && preflightResult.providers.length > 0 && (
                <div className="space-y-3 mt-6">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                      Provider Checks
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {preflightResult.providers.length} provider
                      {preflightResult.providers.length !== 1 ? 's' : ''} configured
                    </p>
                  </div>
                  {preflightResult.providers.map((provider) => (
                    <Card
                      key={provider.id}
                      className={
                        provider.status === 'fail'
                          ? 'border-destructive'
                          : provider.status === 'warn'
                            ? 'border-yellow-600'
                            : 'border-green-600'
                      }
                    >
                      <CardContent className="pt-4">
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5">{getStatusIcon(provider.status)}</div>
                          <div className="flex-1 space-y-2">
                            <div className="flex items-center justify-between">
                              <h4 className="font-semibold">{provider.name}</h4>
                              <Badge
                                variant={
                                  provider.status === 'pass'
                                    ? 'default'
                                    : provider.status === 'fail'
                                      ? 'destructive'
                                      : 'secondary'
                                }
                              >
                                {provider.status.toUpperCase()}
                              </Badge>
                            </div>
                            {provider.binPath && (
                              <div className="text-xs bg-muted p-2 rounded font-mono">
                                {provider.binPath}
                              </div>
                            )}
                            <div className="flex flex-col gap-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge
                                  variant="secondary"
                                  className={
                                    provider.binaryStatus === 'fail'
                                      ? 'border border-destructive bg-destructive/10 text-destructive'
                                      : provider.binaryStatus === 'warn'
                                        ? 'border border-yellow-600 bg-yellow-500/10 text-yellow-700'
                                        : 'border border-emerald-500 bg-emerald-500/10 text-emerald-600'
                                  }
                                >
                                  Binary {provider.binaryStatus.toUpperCase()}
                                </Badge>
                                <span className="text-sm text-muted-foreground">
                                  {provider.binaryMessage}
                                </span>
                              </div>
                              {provider.mcpStatus && (
                                <div className="flex flex-wrap items-center gap-2">
                                  <Badge
                                    variant="secondary"
                                    className={
                                      provider.mcpStatus === 'fail'
                                        ? 'border border-destructive bg-destructive/10 text-destructive'
                                        : provider.mcpStatus === 'warn'
                                          ? 'border border-yellow-600 bg-yellow-500/10 text-yellow-700'
                                          : 'border border-emerald-500 bg-emerald-500/10 text-emerald-600'
                                    }
                                  >
                                    MCP {provider.mcpStatus.toUpperCase()}
                                  </Badge>
                                  <span className="text-sm text-muted-foreground">
                                    {provider.mcpMessage ?? 'MCP not required.'}
                                  </span>
                                </div>
                              )}
                              {/* Endpoint removed from provider card */}
                            </div>
                            {/* Suppress verbose details from MCP list output */}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}

              <p className="text-xs text-muted-foreground mt-4">
                Last checked: {new Date(preflightResult.timestamp).toLocaleString()}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Provider Management */}
      <Card>
        <CardHeader>
          <CardTitle>Provider Management</CardTitle>
          <CardDescription>Configure AI provider binaries and settings</CardDescription>
        </CardHeader>
        <CardContent>
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Manage Providers</AlertTitle>
            <AlertDescription>
              Provider configurations, including binary paths, are now managed through the dedicated{' '}
              <a href="/providers" className="font-semibold underline hover:text-primary">
                Providers
              </a>{' '}
              page. You can add, edit, and configure provider binaries there.
            </AlertDescription>
          </Alert>
          <div className="mt-4">
            <Button variant="outline" onClick={() => (window.location.href = '/providers')}>
              Go to Providers
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
