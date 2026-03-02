import { useEffect, useState } from 'react';
import { Button } from '@/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/components/ui/card';
import { Label } from '@/ui/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { Loader2 } from 'lucide-react';
import {
  DEFAULT_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_SCROLLBACK,
} from '@/common/constants/terminal';
import { useSettingsData } from './useSettingsData';

const DEFAULT_TERMINAL_SEED_MAX_BYTES = 1024 * 1024;
const MIN_TERMINAL_SEED_MAX_BYTES = 64 * 1024;
const MAX_TERMINAL_SEED_MAX_BYTES = 4 * 1024 * 1024;

export function TerminalSection() {
  const { settings, updateTerminalMutation, updateIdleTimeoutMutation } = useSettingsData();

  const [scrollbackLines, setScrollbackLines] = useState<number | ''>('');
  const [seedMaxKb, setSeedMaxKb] = useState<number | ''>('');
  const [terminalInputMode, setTerminalInputMode] = useState<'form' | 'tty'>('form');
  const [idleTimeoutSec, setIdleTimeoutSec] = useState<number | ''>('');

  useEffect(() => {
    if (!settings) return;
    const lines = settings.terminal?.scrollbackLines ?? DEFAULT_TERMINAL_SCROLLBACK;
    setScrollbackLines(lines);
    const maxBytes = settings.terminal?.seedingMaxBytes ?? DEFAULT_TERMINAL_SEED_MAX_BYTES;
    setSeedMaxKb(Math.round(maxBytes / 1024));
    setTerminalInputMode(settings.terminal?.inputMode ?? 'form');
  }, [settings]);

  useEffect(() => {
    const ms = settings?.activity?.idleTimeoutMs ?? 30000;
    setIdleTimeoutSec(Math.floor(ms / 1000));
  }, [settings]);

  return (
    <div className="space-y-6">
      {/* Terminal Settings */}
      <Card>
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
                disabled={updateTerminalMutation.isPending}
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
                disabled={updateTerminalMutation.isPending}
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
                disabled={updateTerminalMutation.isPending}
              />
              <p className="text-xs text-muted-foreground">
                Caps the initial ANSI snapshot size (min {MIN_TERMINAL_SEED_MAX_BYTES / 1024}KB, max{' '}
                {MAX_TERMINAL_SEED_MAX_BYTES / 1024}KB).
              </p>
            </div>
            <div>
              <Button
                disabled={
                  scrollbackLines === '' || seedMaxKb === '' || updateTerminalMutation.isPending
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
                  updateTerminalMutation.mutate({
                    scrollbackLines: coercedLines,
                    seedingMaxBytes: coercedSeedKb * 1024,
                    inputMode: terminalInputMode,
                  });
                }}
              >
                {updateTerminalMutation.isPending ? (
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
      <Card>
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
    </div>
  );
}
