import {
  TerminalSeedDelivery,
  TerminalSeedService,
  type TerminalSeedDeliveryDecision,
} from './terminal-seed.service';
import {
  SettingsService,
  DEFAULT_TERMINAL_SEED_MAX_BYTES,
} from '../../settings/services/settings.service';
import { TerminalSessionRegistry } from './terminal-session/terminal-session-registry';
import { TerminalIOService } from './terminal-io/terminal-io.service';
import { SessionsService } from '../../sessions/services/sessions.service';
import type { Socket } from 'socket.io';

describe('TerminalSeedService', () => {
  let seedService: TerminalSeedService;
  let settingsService: jest.Mocked<Partial<SettingsService>>;
  let terminalSessionRegistry: jest.Mocked<Partial<TerminalSessionRegistry>>;
  let terminalIO: jest.Mocked<Partial<TerminalIOService>>;
  let sessionsService: jest.Mocked<Partial<SessionsService>>;

  beforeEach(() => {
    settingsService = {
      getSetting: jest.fn(),
      getScrollbackLines: jest.fn().mockReturnValue(10000),
    };

    terminalSessionRegistry = {
      get: jest.fn().mockReturnValue(undefined),
    };

    terminalIO = {
      captureHistory: jest.fn().mockResolvedValue({ ok: true, output: '' }),
      getCursorPosition: jest.fn().mockResolvedValue(null),
    };

    sessionsService = {
      getSession: jest.fn().mockReturnValue(null),
      usesAlternateScreenFor: jest.fn().mockReturnValue(false),
    };

    seedService = new TerminalSeedService(
      settingsService as SettingsService,
      terminalSessionRegistry as unknown as TerminalSessionRegistry,
      terminalIO as TerminalIOService,
      sessionsService as SessionsService,
    );
  });

  describe('resolveSeedingConfig', () => {
    it('should return default maxBytes when no settings are available', () => {
      settingsService.getSetting = jest.fn().mockReturnValue(undefined);

      const config = seedService.resolveSeedingConfig();

      expect(config).toEqual({
        maxBytes: DEFAULT_TERMINAL_SEED_MAX_BYTES,
      });
    });

    it('should return custom maxBytes from settings', () => {
      const customMaxBytes = 512 * 1024; // 512KB
      settingsService.getSetting = jest.fn((key: string) => {
        if (key === 'terminal.seeding.maxBytes') return String(customMaxBytes);
        return undefined;
      });

      const config = seedService.resolveSeedingConfig();

      expect(config.maxBytes).toBe(customMaxBytes);
    });

    it('should clamp maxBytes to minimum value', () => {
      settingsService.getSetting = jest.fn((key: string) => {
        if (key === 'terminal.seeding.maxBytes') return '1000'; // Below minimum
        return undefined;
      });

      const config = seedService.resolveSeedingConfig();

      expect(config.maxBytes).toBeGreaterThanOrEqual(64 * 1024); // MIN_TERMINAL_SEED_MAX_BYTES
    });

    it('should clamp maxBytes to maximum value', () => {
      settingsService.getSetting = jest.fn((key: string) => {
        if (key === 'terminal.seeding.maxBytes') return '10000000000'; // Above maximum
        return undefined;
      });

      const config = seedService.resolveSeedingConfig();

      expect(config.maxBytes).toBeLessThanOrEqual(4 * 1024 * 1024); // MAX_TERMINAL_SEED_MAX_BYTES (4MB)
    });

    it('should handle invalid maxBytes gracefully', () => {
      settingsService.getSetting = jest.fn((key: string) => {
        if (key === 'terminal.seeding.maxBytes') return 'not-a-number';
        return undefined;
      });

      const config = seedService.resolveSeedingConfig();

      expect(config.maxBytes).toBe(DEFAULT_TERMINAL_SEED_MAX_BYTES); // Should use default
    });
  });

  describe('invalidateCache', () => {
    it('should invalidate cache for a session', () => {
      // This is a simple test to ensure the method exists and doesn't throw
      expect(() => seedService.invalidateCache('session-123')).not.toThrow();
    });
  });

  describe('truncateToMaxBytes', () => {
    it('should return content unchanged when within maxBytes', () => {
      const content = 'short content';
      const result = seedService.truncateToMaxBytes(content, 1000);
      expect(result.truncated).toBe(content);
      expect(result.wasTruncated).toBe(false);
    });

    it('should truncate multi-line content preserving newest lines', () => {
      const content = 'line1\nline2\nline3\nline4\nline5';
      // Set maxBytes to fit only 2 lines (line4\nline5 = ~12 bytes)
      const result = seedService.truncateToMaxBytes(content, 15);
      expect(result.truncated).toContain('line5');
      expect(result.wasTruncated).toBe(true);
    });

    it('should handle single long line exceeding maxBytes with byte-based fallback', () => {
      // Single line with 100 characters (no newlines)
      const longLine = 'x'.repeat(100);
      const result = seedService.truncateToMaxBytes(longLine, 50);

      // At least one complete suffix fits within this budget.
      expect(result.truncated).not.toBe('');
      // Should be truncated
      expect(result.wasTruncated).toBe(true);
      // Should contain approximately maxBytes (50 bytes)
      expect(Buffer.byteLength(result.truncated, 'utf-8')).toBeLessThanOrEqual(50);
      // Should preserve content from the end (newest)
      expect(result.truncated).toBe('x'.repeat(50));
    });

    it('should handle UTF-8 characters in byte-based fallback', () => {
      // UTF-8 chars: emoji (4 bytes each), Japanese (3 bytes each)
      const utf8Content = '日本語テスト文字列'; // 9 Japanese chars, ~27 bytes
      const result = seedService.truncateToMaxBytes(utf8Content, 15);

      // Should NOT return empty string
      expect(result.truncated).not.toBe('');
      expect(result.wasTruncated).toBe(true);
      // Result remains valid UTF-8 and never exceeds the wire budget.
      expect(typeof result.truncated).toBe('string');
      expect(Buffer.byteLength(result.truncated, 'utf-8')).toBeLessThanOrEqual(15);
      expect(result.truncated).not.toContain('�');
    });

    it('should handle content with only one very long line and trailing newline', () => {
      const longLineWithNewline = 'x'.repeat(100) + '\n';
      const result = seedService.truncateToMaxBytes(longLineWithNewline, 50);

      // Should NOT return empty string
      expect(result.truncated).not.toBe('');
      expect(result.wasTruncated).toBe(true);
    });

    describe('truncation performance', () => {
      it('should truncate 1MB content in under 100ms', () => {
        // Generate ~1MB of content (1,000,000 bytes) with realistic line structure
        // Terminal output typically has ~80-120 chars per line
        const lineLength = 100;
        const linesNeeded = Math.ceil(1_000_000 / (lineLength + 1)); // +1 for newline
        const lines: string[] = [];
        for (let i = 0; i < linesNeeded; i++) {
          lines.push('x'.repeat(lineLength));
        }
        const largeContent = lines.join('\n');

        // Verify we have approximately 1MB
        expect(Buffer.byteLength(largeContent, 'utf-8')).toBeGreaterThan(900_000);

        // Time the truncation
        const start = performance.now();
        const result = seedService.truncateToMaxBytes(largeContent, 256 * 1024); // 256KB target
        const elapsed = performance.now() - start;

        // Should complete in under 100ms
        expect(elapsed).toBeLessThan(100);

        // Should have truncated
        expect(result.wasTruncated).toBe(true);
        expect(Buffer.byteLength(result.truncated, 'utf-8')).toBeLessThanOrEqual(256 * 1024);
      });

      it('should handle max settings limit (4MB) content efficiently', () => {
        // Generate ~2MB of content to test with larger (but not max) content
        const lineLength = 100;
        const linesNeeded = Math.ceil(2_000_000 / (lineLength + 1));
        const lines: string[] = [];
        for (let i = 0; i < linesNeeded; i++) {
          lines.push('y'.repeat(lineLength));
        }
        const largeContent = lines.join('\n');

        const start = performance.now();
        const result = seedService.truncateToMaxBytes(largeContent, 1024 * 1024); // 1MB target
        const elapsed = performance.now() - start;

        // Should complete in under 200ms even for 2MB content
        expect(elapsed).toBeLessThan(200);
        expect(result.wasTruncated).toBe(true);
      });
    });
  });

  describe('emitSeedToClient', () => {
    let mockClient: jest.Mocked<Partial<Socket>>;
    let deliver: (envelope: unknown) => TerminalSeedDeliveryDecision;

    beforeEach(() => {
      mockClient = {
        emit: jest.fn(),
      };
      deliver = (envelope) => {
        mockClient.emit!('message', envelope);
        return TerminalSeedDelivery.Continue;
      };

      sessionsService.getSession = jest.fn().mockReturnValue({
        id: 'session-123',
        tmuxSessionId: 'tmux-123',
      }) as jest.Mock;

      terminalIO.captureHistory = jest.fn().mockResolvedValue({
        ok: true,
        output: 'captured-output\n',
      });
      terminalIO.getCursorPosition = jest.fn().mockResolvedValue({ x: 10, y: 5 });

      terminalSessionRegistry.get = jest
        .fn()
        .mockReturnValue({ getDimensions: () => ({ cols: 80, rows: 24 }) });
    });

    it('should emit seed snapshot to client', async () => {
      await seedService.emitSeedToClient({
        deliver,
        sessionId: 'session-123',
        maxBytes: 1024 * 1024,
        cols: 80,
        rows: 24,
      });

      expect(mockClient.emit).toHaveBeenCalled();
    });

    it('pure service unit: stops a multi-chunk seed immediately when delivery aborts', async () => {
      terminalIO.captureHistory = jest.fn().mockResolvedValue({
        ok: true,
        output: `${'x'.repeat(140 * 1024)}\n`,
      });
      const abortingDeliver = jest.fn().mockReturnValue(TerminalSeedDelivery.Abort);

      await seedService.emitSeedToClient({
        deliver: abortingDeliver,
        sessionId: 'session-123',
        maxBytes: 256 * 1024,
      });

      expect(abortingDeliver).toHaveBeenCalledTimes(1);
      expect(
        (abortingDeliver.mock.calls[0][0] as { payload: { chunk: number; totalChunks: number } })
          .payload,
      ).toMatchObject({ chunk: 0, totalChunks: 3 });
    });

    it('counts fresh seed captures but not cache hits', async () => {
      const options = {
        deliver,
        sessionId: 'session-123',
        maxBytes: 1024 * 1024,
      };

      await seedService.emitSeedToClient(options);
      await seedService.emitSeedToClient(options);

      expect(terminalIO.captureHistory).toHaveBeenCalledTimes(1);
      expect(seedService.getCaptureStats()).toEqual({ terminalSeedCaptures: 1 });
    });

    it('preserves real trailing blank rows while removing the capture separator', async () => {
      terminalIO.captureHistory = jest.fn().mockResolvedValue({
        ok: true,
        output: 'line 1\r\nline 2\r\n\r\n',
      });

      await seedService.emitSeedToClient({
        deliver,
        sessionId: 'session-123',
        maxBytes: 1024 * 1024,
      });

      const seedCall = (mockClient.emit as jest.Mock).mock.calls.find(
        ([event]) => event === 'message',
      );
      expect((seedCall![1] as { payload: { data: string } }).payload.data).toBe(
        'line 1\r\nline 2\r\n',
      );
    });

    it('caps a line-provider seed by dropping oldest lines and advertises remaining history', async () => {
      terminalIO.captureHistory = jest.fn().mockResolvedValue({
        ok: true,
        output: 'oldest-line\nmiddle-line\nnewest-line\n',
      });

      await seedService.emitSeedToClient({
        deliver,
        sessionId: 'session-123',
        maxBytes: 20,
      });

      const envelopes = (mockClient.emit as jest.Mock).mock.calls.map(([, envelope]) => envelope);
      const seedData = envelopes.map((envelope) => envelope.payload.data).join('');
      expect(Buffer.byteLength(seedData, 'utf8')).toBeLessThanOrEqual(20);
      expect(seedData).toBe('newest-line');
      expect(envelopes.at(-1).payload.hasHistory).toBe(true);
    });

    it('applies the byte cap after line-ending normalization', async () => {
      terminalIO.captureHistory = jest.fn().mockResolvedValue({
        ok: true,
        output: 'a\na\na\na\na\n',
      });

      await seedService.emitSeedToClient({
        deliver,
        sessionId: 'session-123',
        maxBytes: 8,
      });

      const seedData = (mockClient.emit as jest.Mock).mock.calls
        .map(([, envelope]) => envelope.payload.data)
        .join('');
      expect(Buffer.byteLength(seedData, 'utf8')).toBeLessThanOrEqual(8);
      expect(seedData).toContain('\r\n');
    });

    it('never advertises loadable history for an alternate-screen seed', async () => {
      terminalIO.captureHistory = jest.fn().mockResolvedValue({
        ok: true,
        output: 'oldest-line\nmiddle-line\nnewest-line\n',
      });
      sessionsService.usesAlternateScreenFor = jest.fn().mockReturnValue(true) as jest.Mock;

      await seedService.emitSeedToClient({
        deliver,
        sessionId: 'session-123',
        maxBytes: 20,
      });

      const finalEnvelope = (mockClient.emit as jest.Mock).mock.calls.at(-1)?.[1] as {
        payload: { hasHistory?: boolean };
      };
      expect(finalEnvelope.payload.hasHistory).toBe(false);
    });

    it('should handle empty snapshot gracefully', async () => {
      terminalIO.captureHistory = jest.fn().mockResolvedValue({ ok: true, output: '' });

      await seedService.emitSeedToClient({
        deliver,
        sessionId: 'session-123',
        maxBytes: 1024 * 1024,
      });

      expect(mockClient.emit).not.toHaveBeenCalled();
    });

    it('emits an empty replacement seed when resync must clear stale client output', async () => {
      terminalIO.captureHistory = jest.fn().mockResolvedValue({ ok: true, output: '' });

      await seedService.emitSeedToClient({
        deliver,
        sessionId: 'session-123',
        maxBytes: 1024 * 1024,
        allowEmpty: true,
        recovery: {
          recoveryEpoch: 3,
          getCurrentSequence: () => 5,
        },
      });

      expect(mockClient.emit).toHaveBeenCalledWith(
        'message',
        expect.objectContaining({
          type: 'seed_ansi',
          payload: expect.objectContaining({ data: '', chunk: 0, totalChunks: 1 }),
        }),
      );
    });

    it('emits a non-writing seed_empty completion for a successful empty initial capture', async () => {
      terminalIO.captureHistory = jest.fn().mockResolvedValue({ ok: true, output: '' });

      await seedService.emitSeedToClient({
        deliver,
        sessionId: 'session-123',
        maxBytes: 1024 * 1024,
        cols: 80,
        rows: 24,
        allowEmpty: true,
        getCurrentSequence: () => 0,
      });

      const envelopes = (mockClient.emit as jest.Mock).mock.calls.map(([, envelope]) => envelope);
      expect(envelopes).toHaveLength(1);
      expect(envelopes[0]).toMatchObject({
        type: 'seed_empty',
        payload: { capturedSequence: 0, cols: 80, rows: 24 },
      });
      // A completion is distinct from a seed chunk: it must never write data.
      expect(envelopes[0].payload).not.toHaveProperty('data');
    });

    it('samples the empty-completion sequence after capture', async () => {
      let sequence = 2;
      terminalIO.captureHistory = jest.fn().mockImplementation(async () => {
        sequence = 6;
        return { ok: true, output: '' };
      });

      await seedService.emitSeedToClient({
        deliver,
        sessionId: 'session-123',
        maxBytes: 1024 * 1024,
        allowEmpty: true,
        getCurrentSequence: () => sequence,
      });

      const envelope = (mockClient.emit as jest.Mock).mock.calls.at(-1)?.[1] as {
        type: string;
        payload: { capturedSequence: number };
      };
      expect(envelope.type).toBe('seed_empty');
      expect(envelope.payload.capturedSequence).toBe(6);
    });

    it('falls back to a 0 baseline completion when no sequence sampler is provided', async () => {
      terminalIO.captureHistory = jest.fn().mockResolvedValue({ ok: true, output: '' });

      await seedService.emitSeedToClient({
        deliver,
        sessionId: 'session-123',
        maxBytes: 1024 * 1024,
        allowEmpty: true,
      });

      const completion = (mockClient.emit as jest.Mock).mock.calls.find(
        ([, envelope]) => (envelope as { type?: string }).type === 'seed_empty',
      );
      expect(completion).toBeTruthy();
      expect(
        (completion![1] as { payload: { capturedSequence: number } }).payload.capturedSequence,
      ).toBe(0);
    });

    it('samples the recovery watermark after capture and includes it on every seed chunk', async () => {
      let currentSequence = 4;
      terminalIO.captureHistory = jest.fn().mockImplementation(async () => {
        currentSequence = 9;
        return { ok: true, output: `${'x'.repeat(70 * 1024)}\n` };
      });
      terminalIO.getCursorPosition = jest.fn().mockImplementation(async () => {
        currentSequence = 10;
        return { x: 1, y: 1 };
      });
      const captured = jest.fn();

      const watermark = await seedService.emitSeedToClient({
        deliver,
        sessionId: 'session-123',
        maxBytes: 1024 * 1024,
        allowEmpty: true,
        recovery: {
          recoveryEpoch: 7,
          getCurrentSequence: () => currentSequence,
          onCapturedSequence: captured,
        },
      });

      const envelopes = (mockClient.emit as jest.Mock).mock.calls.map(([, envelope]) => envelope);
      expect(envelopes.length).toBeGreaterThan(1);
      expect(envelopes.every((envelope) => envelope.payload.recoveryEpoch === 7)).toBe(true);
      expect(envelopes.every((envelope) => envelope.payload.capturedSequence === 9)).toBe(true);
      expect(captured).toHaveBeenCalledWith(9);
      expect(watermark).toEqual({ recoveryEpoch: 7, capturedSequence: 9 });
    });

    it('should skip seed when tmux capture returns empty (graceful handling)', async () => {
      terminalIO.captureHistory = jest.fn().mockResolvedValue({ ok: true, output: '' });

      await seedService.emitSeedToClient({
        deliver,
        sessionId: 'session-123',
        maxBytes: 1024 * 1024,
      });

      // Should NOT emit seed since tmux returned empty
      expect(mockClient.emit).not.toHaveBeenCalled();
    });
  });
});
