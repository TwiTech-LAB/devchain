import type { ITheme } from '@xterm/xterm';
import type { ThemeValue } from '@/ui/components/ThemeSelect';

export interface TmuxStyle {
  foreground: string;
  background: string;
}

export interface TerminalThemeOutput {
  xtermTheme: ITheme;
  tmuxStyle: TmuxStyle;
}

const XTERM_256_COLOR_STEPS = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff] as const;

function channelToHex(channel: number): string {
  return channel.toString(16).padStart(2, '0');
}

function rgbToHex(red: number, green: number, blue: number): string {
  return `#${channelToHex(red)}${channelToHex(green)}${channelToHex(blue)}`;
}

function createExtendedAnsiPalette(overrides: Partial<Record<number, string>> = {}): string[] {
  const colors: string[] = [];

  for (const red of XTERM_256_COLOR_STEPS) {
    for (const green of XTERM_256_COLOR_STEPS) {
      for (const blue of XTERM_256_COLOR_STEPS) {
        colors.push(rgbToHex(red, green, blue));
      }
    }
  }

  for (let index = 0; index < 24; index += 1) {
    const channel = 8 + index * 10;
    colors.push(rgbToHex(channel, channel, channel));
  }

  for (const [ansiIndexText, color] of Object.entries(overrides)) {
    if (color === undefined) continue;
    const ansiIndex = Number(ansiIndexText);
    if (Number.isInteger(ansiIndex) && ansiIndex >= 16 && ansiIndex <= 255) {
      colors[ansiIndex - 16] = color;
    }
  }

  return colors;
}

const DEFAULT_EXTENDED_ANSI = createExtendedAnsiPalette();
const OCEAN_EXTENDED_ANSI = createExtendedAnsiPalette({
  253: '#d2dee8',
  254: '#dfe8ef',
  255: '#eaf1f5',
});

export const DARK_XTERM_THEME: ITheme = {
  background: '#1a1a1a',
  foreground: '#c9d1d9',
  cursor: '#58a6ff',
  cursorAccent: '#0d1117',
  selectionBackground: '#1f6feb',
  selectionForeground: '#ffffff',
  black: '#484f58',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc',
  extendedAnsi: DEFAULT_EXTENDED_ANSI,
};

export const OCEAN_XTERM_THEME: ITheme = {
  background: '#eaf1f5',
  foreground: '#172b3a',
  cursor: '#0b6e99',
  cursorAccent: '#eaf1f5',
  selectionBackground: '#b3d5f0',
  selectionForeground: '#172b3a',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#6e4b00',
  blue: '#0550ae',
  magenta: '#7c3aed',
  cyan: '#0969da',
  white: '#666e78',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7e37',
  brightYellow: '#633c01',
  brightBlue: '#256fbc',
  brightMagenta: '#6639ba',
  brightCyan: '#1a787f',
  brightWhite: '#393b40',
  extendedAnsi: OCEAN_EXTENDED_ANSI,
};

const DARK_TMUX_STYLE: TmuxStyle = {
  foreground: '#c9d1d9',
  background: '#1a1a1a',
};

const OCEAN_TMUX_STYLE: TmuxStyle = {
  foreground: '#172b3a',
  background: '#eaf1f5',
};

export function resolveTerminalTheme(theme: ThemeValue): TerminalThemeOutput {
  if (theme === 'ocean') {
    return { xtermTheme: OCEAN_XTERM_THEME, tmuxStyle: OCEAN_TMUX_STYLE };
  }
  return { xtermTheme: DARK_XTERM_THEME, tmuxStyle: DARK_TMUX_STYLE };
}
