import fs from 'fs';
import path from 'path';
import type { ThemeValue } from '@/ui/components/ThemeSelect';
import {
  contrast,
  cssBlock,
  cssVariable,
  hexToRgb,
  hslToRgb,
  rgbToHex,
} from '@/ui/styles/testing/theme-colors';
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

const ANSI_KEYS = REQUIRED_PALETTE_KEYS.slice(6);

describe('resolveTerminalTheme', () => {
  describe('dark theme', () => {
    it.each([
      ['dark', DARK_XTERM_THEME],
      ['ocean', OCEAN_XTERM_THEME],
    ] as const)('resolves %s xterm constant', (name, theme) => {
      const result = resolveTerminalTheme(name);
      expect(result.xtermTheme).toBe(theme);
    });

    it('returns correct tmuxStyle for dark', () => {
      const { tmuxStyle } = resolveTerminalTheme('dark');
      expect(tmuxStyle.foreground).toBe('#c9d1d9');
      expect(tmuxStyle.background).toBe('#1a1a1a');
      const { xtermTheme } = resolveTerminalTheme('dark');
      expect(xtermTheme.background).toBe('#1a1a1a');
      expect(xtermTheme.foreground).toBe('#c9d1d9');
    });
  });

  describe('ocean theme', () => {
    it('returns correct tmuxStyle for ocean', () => {
      const { tmuxStyle } = resolveTerminalTheme('ocean');
      expect(tmuxStyle.foreground).toBe('#172b3a');
      expect(tmuxStyle.background).toBe('#eaf1f5');
      expect(tmuxStyle).toEqual({
        foreground: OCEAN_XTERM_THEME.foreground,
        background: OCEAN_XTERM_THEME.background,
      });
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
    it.each(['dark', 'ocean'] as const)('keeps %s xterm and tmux objects separate', (name) => {
      const result = resolveTerminalTheme(name);
      expect(result.xtermTheme).not.toBe(result.tmuxStyle);
    });
  });

  describe('required palette keys', () => {
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

      expect(OCEAN_XTERM_THEME.extendedAnsi?.[236 - 16]).toBe('#303030');

      expect(OCEAN_XTERM_THEME.extendedAnsi?.[254 - 16]).toBe('#dfe8ef');
      expect(OCEAN_XTERM_THEME.extendedAnsi?.[253 - 16]).toBe('#d2dee8');
    });
  });

  describe('ocean palette', () => {
    it('uses the Ocean Light canvas, text and primary colors', () => {
      expect(OCEAN_XTERM_THEME).toMatchObject({
        background: '#eaf1f5',
        cursorAccent: '#eaf1f5',
        foreground: '#172b3a',
        selectionForeground: '#172b3a',
        cursor: '#0b6e99',
        selectionBackground: '#b3d5f0',
      });
    });

    it.each(['foreground', ...ANSI_KEYS] as const)(
      '%s is at least 4.5:1 on the ocean terminal background',
      (key) => {
        expect(
          contrast(
            hexToRgb(OCEAN_XTERM_THEME[key] as string),
            hexToRgb(OCEAN_XTERM_THEME.background as string),
          ),
        ).toBeGreaterThanOrEqual(4.5);
      },
    );

    // Layer: source contract (Jest). The CSS tokens paint the terminal chrome around xterm,
    // so reading the stylesheet is the cheapest proof that the two stay in sync.
    it('keeps the .theme-ocean --terminal-* tokens equal to the xterm colors', () => {
      const css = fs.readFileSync(path.resolve(__dirname, '../../styles/global.css'), 'utf-8');
      const oceanBlock = cssBlock(css, '.theme-ocean {');
      const token = (name: string) =>
        rgbToHex(hslToRgb(cssVariable(oceanBlock, `terminal-${name}`)));

      expect(token('background')).toBe(OCEAN_XTERM_THEME.background);
      expect(token('foreground')).toBe(OCEAN_XTERM_THEME.foreground);
      expect(token('cursor')).toBe(OCEAN_XTERM_THEME.cursor);
      expect(token('selection')).toBe(OCEAN_XTERM_THEME.selectionBackground);
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
