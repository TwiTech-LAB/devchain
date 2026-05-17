import type { ThemeValue } from '@/ui/components/ThemeSelect';
import { DARK_XTERM_THEME, OCEAN_XTERM_THEME, resolveTerminalTheme } from './terminal-themes';

const REQUIRED_PALETTE_KEYS = [
  'background',
  'foreground',
  'cursor',
  'cursorAccent',
  'selectionBackground',
  'selectionForeground',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

const STRICT_HEX_RE = /^#[0-9a-fA-F]{6}$/;

describe('resolveTerminalTheme', () => {
  describe('dark theme', () => {
    it('returns the DARK_XTERM_THEME constant as xtermTheme', () => {
      const result = resolveTerminalTheme('dark');
      expect(result.xtermTheme).toBe(DARK_XTERM_THEME);
    });

    it('returns correct tmuxStyle for dark', () => {
      const { tmuxStyle } = resolveTerminalTheme('dark');
      expect(tmuxStyle.foreground).toBe('#c9d1d9');
      expect(tmuxStyle.background).toBe('#1a1a1a');
    });

    it('has dual output shape with xtermTheme and tmuxStyle', () => {
      const result = resolveTerminalTheme('dark');
      expect(result).toHaveProperty('xtermTheme');
      expect(result).toHaveProperty('tmuxStyle');
      expect(result.tmuxStyle).toHaveProperty('foreground');
      expect(result.tmuxStyle).toHaveProperty('background');
    });

    it('preserves unchanged dark background and foreground', () => {
      const { xtermTheme } = resolveTerminalTheme('dark');
      expect(xtermTheme.background).toBe('#1a1a1a');
      expect(xtermTheme.foreground).toBe('#c9d1d9');
    });
  });

  describe('ocean theme', () => {
    it('returns the OCEAN_XTERM_THEME constant as xtermTheme', () => {
      const result = resolveTerminalTheme('ocean');
      expect(result.xtermTheme).toBe(OCEAN_XTERM_THEME);
    });

    it('returns correct tmuxStyle for ocean', () => {
      const { tmuxStyle } = resolveTerminalTheme('ocean');
      expect(tmuxStyle.foreground).toBe('#1d2b3a');
      expect(tmuxStyle.background).toBe('#eaeff5');
    });

    it('has dual output shape with xtermTheme and tmuxStyle', () => {
      const result = resolveTerminalTheme('ocean');
      expect(result).toHaveProperty('xtermTheme');
      expect(result).toHaveProperty('tmuxStyle');
      expect(result.tmuxStyle).toHaveProperty('foreground');
      expect(result.tmuxStyle).toHaveProperty('background');
    });

    it('has a light background (luminance > 0.7)', () => {
      const bg = OCEAN_XTERM_THEME.background ?? '';
      const r = parseInt(bg.slice(1, 3), 16);
      const g = parseInt(bg.slice(3, 5), 16);
      const b = parseInt(bg.slice(5, 7), 16);
      const luminance = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
      expect(luminance).toBeGreaterThan(0.7);
    });

    it('has a dark foreground (luminance < 0.3)', () => {
      const fg = OCEAN_XTERM_THEME.foreground ?? '';
      const r = parseInt(fg.slice(1, 3), 16);
      const g = parseInt(fg.slice(3, 5), 16);
      const b = parseInt(fg.slice(5, 7), 16);
      const luminance = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
      expect(luminance).toBeLessThan(0.3);
    });
  });

  describe('fallback behavior', () => {
    it('falls back to dark for unknown theme values', () => {
      const result = resolveTerminalTheme('unknown' as ThemeValue);
      expect(result.xtermTheme).toBe(DARK_XTERM_THEME);
      expect(result.tmuxStyle.background).toBe('#1a1a1a');
    });
  });

  describe('dual output shape — xtermTheme and tmuxStyle cannot be confused', () => {
    it('dark xtermTheme and tmuxStyle are separate objects', () => {
      const result = resolveTerminalTheme('dark');
      expect(result.xtermTheme).not.toBe(result.tmuxStyle);
    });

    it('ocean xtermTheme and tmuxStyle are separate objects', () => {
      const result = resolveTerminalTheme('ocean');
      expect(result.xtermTheme).not.toBe(result.tmuxStyle);
    });

    it('resolver is deterministic: two calls with same theme return same references', () => {
      expect(resolveTerminalTheme('dark').xtermTheme).toBe(resolveTerminalTheme('dark').xtermTheme);
      expect(resolveTerminalTheme('ocean').xtermTheme).toBe(
        resolveTerminalTheme('ocean').xtermTheme,
      );
    });
  });

  describe('required palette keys', () => {
    it.each(['dark', 'ocean'] as ThemeValue[])(
      '%s xtermTheme contains all required ANSI palette keys',
      (theme) => {
        const { xtermTheme } = resolveTerminalTheme(theme);
        for (const key of REQUIRED_PALETTE_KEYS) {
          expect(xtermTheme[key]).toBeDefined();
        }
      },
    );

    it.each(['dark', 'ocean'] as ThemeValue[])(
      '%s xtermTheme contains the full ANSI 16-255 palette',
      (theme) => {
        const { xtermTheme } = resolveTerminalTheme(theme);
        expect(xtermTheme.extendedAnsi).toHaveLength(240);
        for (const color of xtermTheme.extendedAnsi ?? []) {
          expect(color).toMatch(STRICT_HEX_RE);
        }
      },
    );

    it('maps Ocean ANSI 255 to the terminal background', () => {
      expect(OCEAN_XTERM_THEME.extendedAnsi?.[255 - 16]).toBe(OCEAN_XTERM_THEME.background);
    });

    it('keeps Ocean ANSI 236 dark for TUIs that use it as foreground text', () => {
      expect(OCEAN_XTERM_THEME.extendedAnsi?.[236 - 16]).toBe('#303030');
    });
  });

  describe('tmuxStyle strict #RRGGBB values', () => {
    it.each(['dark', 'ocean'] as ThemeValue[])(
      '%s tmuxStyle foreground and background are strict #RRGGBB',
      (theme) => {
        const { tmuxStyle } = resolveTerminalTheme(theme);
        expect(tmuxStyle.foreground).toMatch(STRICT_HEX_RE);
        expect(tmuxStyle.background).toMatch(STRICT_HEX_RE);
      },
    );
  });
});
