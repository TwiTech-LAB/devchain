import type { ThemeValue } from '@/ui/components/ThemeSelect';
import type { WsEnvelope } from '@/ui/lib/socket';

const CLAUDE_DARK_BLOCK_REWRITES: Array<[RegExp, string]> = [
  [/\x1b\[38;5;231m\x1b\[48;5;237m/g, '\x1b[38;5;236m\x1b[48;5;255m'],
  [/\x1b\[38;5;239m\x1b\[48;5;237m/g, '\x1b[38;5;236m\x1b[48;5;255m'],
  [/\x1b\[48;5;237m/g, '\x1b[48;5;255m'],
  [/\x1b\[38;5;231m/g, '\x1b[38;5;236m'],
];

export function rewriteTerminalOutputForTheme(data: string, theme: ThemeValue): string {
  if (theme !== 'ocean' || data.length === 0) {
    return data;
  }

  return CLAUDE_DARK_BLOCK_REWRITES.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    data,
  );
}

export function normalizeTerminalEnvelopeForTheme(
  envelope: WsEnvelope,
  theme: ThemeValue,
): WsEnvelope {
  if (theme !== 'ocean' || !envelope.payload || typeof envelope.payload !== 'object') {
    return envelope;
  }

  const payload = envelope.payload as Record<string, unknown>;

  if (
    (envelope.type === 'data' || envelope.type === 'seed_ansi') &&
    typeof payload.data === 'string'
  ) {
    return {
      ...envelope,
      payload: {
        ...payload,
        data: rewriteTerminalOutputForTheme(payload.data, theme),
      },
    };
  }

  if (envelope.type === 'full_history' && typeof payload.history === 'string') {
    return {
      ...envelope,
      payload: {
        ...payload,
        history: rewriteTerminalOutputForTheme(payload.history, theme),
      },
    };
  }

  return envelope;
}
