import { TerminalSeedService } from './terminal-seed.service';
import {
  SettingsService,
  DEFAULT_TERMINAL_SEED_MAX_BYTES,
} from '../../settings/services/settings.service';
import { PtyService } from './pty.service';
import { ModuleRef } from '@nestjs/core';
import type { Socket } from 'socket.io';

describe('TerminalSeedService', () => {
  let seedService: TerminalSeedService;
  let settingsService: jest.Mocked<Partial<SettingsService>>;
  let ptyService: jest.Mocked<Partial<PtyService>>;
  let moduleRef: jest.Mocked<Partial<ModuleRef>>;

  beforeEach(() => {
    settingsService = {
      getSetting: jest.fn(),
      getScrollbackLines: jest.fn().mockReturnValue(10000),
    };

    ptyService = {
      getDimensions: jest.fn(),
    };

    moduleRef = {
      get: jest.fn(),
    };

    seedService = new TerminalSeedService(
      settingsService as SettingsService,
      ptyService as PtyService,
      moduleRef as ModuleRef,
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

      // Should NOT return empty string (the bug this fixes)
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
      // Result should be valid string (may contain replacement char if split mid-char)
      expect(typeof result.truncated).toBe('string');
      expect(Buffer.byteLength(result.truncated, 'utf-8')).toBeLessThanOrEqual(15);
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

    beforeEach(() => {
      mockClient = {
        emit: jest.fn(),
      };

      // Mock SessionsService
      const mockSessionsService = {
        getSession: jest.fn().mockReturnValue({
          id: 'session-123',
          tmuxSessionId: 'tmux-123',
        }),
      };

      // Mock TmuxService
      const mockTmuxService = {
        capturePane: jest.fn().mockResolvedValue('captured-output\n'),
        getCursorPosition: jest.fn().mockResolvedValue({ x: 10, y: 5 }),
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      moduleRef.get = jest.fn((service: any) => {
        const serviceName = typeof service === 'function' ? service.name : String(service);
        if (serviceName === 'SessionsService') return mockSessionsService;
        if (serviceName === 'TmuxService') return mockTmuxService;
        return undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;

      ptyService.getDimensions = jest.fn().mockReturnValue({ cols: 80, rows: 24 });
    });

    it('should emit seed snapshot to client', async () => {
      await seedService.emitSeedToClient({
        client: mockClient as Socket,
        sessionId: 'session-123',
        maxBytes: 1024 * 1024,
        cols: 80,
        rows: 24,
      });

      // Should emit at least one message
      expect(mockClient.emit).toHaveBeenCalled();
    });

    it('should handle empty snapshot gracefully', async () => {
      const mockTmuxService = {
        capturePane: jest.fn().mockResolvedValue(''),
        getCursorPosition: jest.fn().mockResolvedValue({ x: 10, y: 5 }),
      };

      const mockSessionsService = {
        getSession: jest.fn().mockReturnValue({
          id: 'session-123',
          tmuxSessionId: 'tmux-123',
        }),
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      moduleRef.get = jest.fn((service: any) => {
        const serviceName = typeof service === 'function' ? service.name : String(service);
        if (serviceName === 'TmuxService') return mockTmuxService;
        if (serviceName === 'SessionsService') return mockSessionsService;
        return undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;

      await seedService.emitSeedToClient({
        client: mockClient as Socket,
        sessionId: 'session-123',
        maxBytes: 1024 * 1024,
      });

      // Should not emit seed if snapshot is empty
      expect(mockClient.emit).not.toHaveBeenCalled();
    });

    it('should skip seed when tmux capture returns empty (graceful handling)', async () => {
      // Setup: tmux capture returns empty - skip seed gracefully
      const mockTmuxService = {
        capturePane: jest.fn().mockResolvedValue(''),
        getCursorPosition: jest.fn().mockResolvedValue({ x: 0, y: 0 }),
      };

      const mockSessionsService = {
        getSession: jest.fn().mockReturnValue({
          id: 'session-123',
          tmuxSessionId: 'tmux-123',
        }),
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      moduleRef.get = jest.fn((service: any) => {
        const serviceName = typeof service === 'function' ? service.name : String(service);
        if (serviceName === 'TmuxService') return mockTmuxService;
        if (serviceName === 'SessionsService') return mockSessionsService;
        return undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;

      ptyService.getDimensions = jest.fn().mockReturnValue({ cols: 80, rows: 24 });

      await seedService.emitSeedToClient({
        client: mockClient as Socket,
        sessionId: 'session-123',
        maxBytes: 1024 * 1024,
      });

      // Should NOT emit seed since tmux returned empty
      expect(mockClient.emit).not.toHaveBeenCalled();
    });
  });
});
