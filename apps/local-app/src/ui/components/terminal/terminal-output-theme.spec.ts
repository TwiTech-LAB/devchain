import {
  normalizeTerminalEnvelopeForTheme,
  rewriteTerminalOutputForTheme,
} from './terminal-output-theme';
import type { WsEnvelope } from '@/ui/lib/socket';

describe('terminal output theme normalization', () => {
  it('leaves terminal output unchanged in dark mode', () => {
    const input = '\x1b[38;5;231m\x1b[48;5;237m Jump to bottom ';

    expect(rewriteTerminalOutputForTheme(input, 'dark')).toBe(input);
  });

  it('rewrites Claude dark 256-color blocks for ocean mode', () => {
    const input =
      '\x1b[38;5;231m\x1b[48;5;237m Jump to bottom \x1b[38;5;239m\x1b[48;5;237m❯ task \x1b[38;5;231mwhite';

    expect(rewriteTerminalOutputForTheme(input, 'ocean')).toBe(
      '\x1b[38;5;236m\x1b[48;5;255m Jump to bottom \x1b[38;5;236m\x1b[48;5;255m❯ task \x1b[38;5;236mwhite',
    );
  });

  it('normalizes data envelopes without mutating the original envelope', () => {
    const envelope: WsEnvelope = {
      topic: 'terminal/session-1',
      type: 'data',
      payload: { data: '\x1b[48;5;237mdark block' },
      ts: '2026-05-13T00:00:00.000Z',
    };

    const normalized = normalizeTerminalEnvelopeForTheme(envelope, 'ocean');

    expect(normalized).not.toBe(envelope);
    expect(normalized.payload).toEqual({ data: '\x1b[48;5;255mdark block' });
    expect(envelope.payload).toEqual({ data: '\x1b[48;5;237mdark block' });
  });

  it('normalizes seed and full-history payloads', () => {
    const seed: WsEnvelope = {
      topic: 'terminal/session-1',
      type: 'seed_ansi',
      payload: { data: '\x1b[48;5;237mseed', chunk: 0, totalChunks: 1 },
      ts: '2026-05-13T00:00:00.000Z',
    };
    const history: WsEnvelope = {
      topic: 'terminal/session-1',
      type: 'full_history',
      payload: { history: '\x1b[48;5;237mhistory' },
      ts: '2026-05-13T00:00:00.000Z',
    };

    expect(normalizeTerminalEnvelopeForTheme(seed, 'ocean').payload).toMatchObject({
      data: '\x1b[48;5;255mseed',
    });
    expect(normalizeTerminalEnvelopeForTheme(history, 'ocean').payload).toMatchObject({
      history: '\x1b[48;5;255mhistory',
    });
  });
});
