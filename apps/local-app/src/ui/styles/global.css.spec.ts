import fs from 'fs';
import path from 'path';
import type { Config } from 'tailwindcss';
import {
  WHITE,
  contrast,
  cssBlock,
  cssVariable,
  hslToRgb,
  tint,
  type Rgb,
} from './testing/theme-colors';

const cssPath = path.resolve(__dirname, 'global.css');
const css = fs.readFileSync(cssPath, 'utf-8');
const eventBusCss = fs.readFileSync(
  path.resolve(__dirname, '../components/chat/agent-event-bus/agent-event-bus.css'),
  'utf-8',
);

const blockFor = (selector: string) => cssBlock(css, selector);
const variableValue = cssVariable;

// Layer: UI source-contract unit (Jest). Reading the stylesheets is the cheapest
// reliable proof that every theme declares distinct raw tokens and that the bus
// consumes them; computed layout and hit-testing remain Playwright's responsibility.
describe('global.css theme variable completeness', () => {
  const requiredVars = [
    'background',
    'foreground',
    'card',
    'card-foreground',
    'popover',
    'popover-foreground',
    'primary',
    'primary-foreground',
    'secondary',
    'secondary-foreground',
    'muted',
    'muted-foreground',
    'accent',
    'accent-foreground',
    'destructive',
    'destructive-foreground',
    'destructive-text',
    'border',
    'input',
    'ring',
    'event-bus-agent-message',
    'event-bus-session-started',
    'event-bus-epic-assigned',
    'event-bus-spark',
    'terminal-background',
    'terminal-foreground',
    'terminal-cursor',
    'terminal-selection',
    'terminal-selection-opacity',
    'status-ok',
    'status-warn',
    'canvas',
    'shell',
    'group',
    'selected',
    'selected-foreground',
    'overlay',
    'status-info',
    'switch-off',
  ];

  it('root defines the full variable set', () => {
    const rootBlock = blockFor(':root {');
    for (const v of requiredVars) {
      expect(rootBlock).toContain(`--${v}:`);
    }
  });

  it('dark defines full variable set including terminal vars', () => {
    const darkBlock = blockFor('.dark {');
    for (const v of requiredVars) {
      expect(darkBlock).toContain(`--${v}:`);
    }
  });

  it('theme-ocean defines full variable set including terminal vars', () => {
    const oceanBlock = blockFor('.theme-ocean {');
    for (const v of requiredVars) {
      expect(oceanBlock).toContain(`--${v}:`);
    }
  });

  it.each([':root {', '.dark {', '.theme-ocean {'])(
    '%s defines distinct raw HSL channels for both event kinds',
    (selector) => {
      const block = blockFor(selector);
      const agentMessage = variableValue(block, 'event-bus-agent-message');
      const sessionStarted = variableValue(block, 'event-bus-session-started');
      const spark = variableValue(block, 'event-bus-spark');

      expect(agentMessage).toMatch(/^\d+(?:\.\d+)? \d+(?:\.\d+)?% \d+(?:\.\d+)?%$/);
      expect(sessionStarted).toMatch(/^\d+(?:\.\d+)? \d+(?:\.\d+)?% \d+(?:\.\d+)?%$/);
      expect(spark).toMatch(/^\d+(?:\.\d+)? \d+(?:\.\d+)?% \d+(?:\.\d+)?%$/);
      expect(agentMessage).not.toBe(sessionStarted);
      expect(agentMessage).not.toContain('hsl(');
      expect(sessionStarted).not.toContain('hsl(');
    },
  );

  it.each([':root {', '.dark {', '.theme-ocean {'])(
    '%s defines distinct raw HSL channels for the status tones',
    (selector) => {
      const block = blockFor(selector);
      const ok = variableValue(block, 'status-ok');
      const warn = variableValue(block, 'status-warn');

      expect(ok).toMatch(/^\d+(?:\.\d+)? \d+(?:\.\d+)?% \d+(?:\.\d+)?%$/);
      expect(warn).toMatch(/^\d+(?:\.\d+)? \d+(?:\.\d+)?% \d+(?:\.\d+)?%$/);
      expect(ok).not.toBe(warn);
    },
  );

  it('keeps ocean agent-message cyan distinct from the ambient primary blue', () => {
    const oceanBlock = blockFor('.theme-ocean {');
    expect(variableValue(oceanBlock, 'event-bus-agent-message')).not.toBe(
      variableValue(oceanBlock, 'primary'),
    );
  });

  it.each([
    ['.dark {', 'dark'],
    ['.theme-ocean {', 'light'],
  ])('%s sets color-scheme so native controls match the theme', (selector, scheme) => {
    expect(blockFor(selector)).toContain(`color-scheme: ${scheme};`);
  });

  it('keeps the overlay alpha inside the variable: navy in ocean, black at 0.8 elsewhere', () => {
    expect(variableValue(blockFor('.theme-ocean {'), 'overlay')).toBe('205.7 43.2% 15.9% / 0.32');
    expect(variableValue(blockFor(':root {'), 'overlay')).toBe('0 0% 0% / 0.8');
    expect(variableValue(blockFor('.dark {'), 'overlay')).toBe('0 0% 0% / 0.8');
  });

  it('keeps the light and ocean text red equal to their fill red and lifts the dark one', () => {
    for (const selector of [':root {', '.theme-ocean {']) {
      const block = blockFor(selector);
      expect(variableValue(block, 'destructive-text')).toBe(variableValue(block, 'destructive'));
    }
    expect(variableValue(blockFor('.dark {'), 'destructive-text')).toBe('0 91% 71%');
  });

  it('uses ink sparks in light palettes and a near-white spark in dark', () => {
    expect(variableValue(blockFor(':root {'), 'event-bus-spark')).toBe('222.2 47.4% 11.2%');
    expect(variableValue(blockFor('.theme-ocean {'), 'event-bus-spark')).toBe('215 35% 18%');
    expect(variableValue(blockFor('.dark {'), 'event-bus-spark')).toBe('0 0% 96%');
  });

  it('uses semantic theme channels without a literal white event-bus fallback', () => {
    expect(eventBusCss).toContain('hsl(var(--event-bus-agent-message))');
    expect(eventBusCss).toContain('hsl(var(--event-bus-session-started))');
    expect(eventBusCss).toContain('hsl(var(--event-bus-spark))');
    expect(eventBusCss).not.toMatch(/\bwhite\b|#fff(?:fff)?\b/i);
    expect(eventBusCss).toContain('left: 0;');
    expect(eventBusCss).toContain('width: 12px;');
    expect(eventBusCss).toContain('box-shadow: inset 0 0 0 1px hsl(var(--ring));');
  });
});

describe('global.css xterm scrollbar theming', () => {
  it('dark xterm-viewport scrollbar is scoped under .dark', () => {
    expect(css).toContain('.dark .xterm-viewport::-webkit-scrollbar');
    expect(css).toContain('.dark .xterm-viewport {');
  });

  it('dark xterm-viewport scrollbar uses dark track and thumb colors', () => {
    const darkXtermStart = css.indexOf('.dark .xterm-viewport::-webkit-scrollbar');
    const darkXtermSection = css.slice(darkXtermStart, darkXtermStart + 600);
    expect(darkXtermSection).toContain('#252525');
    expect(darkXtermSection).toContain('#5a5a5a');
  });

  it('no global .xterm-viewport rule forces dark colors on all themes', () => {
    // A bare .xterm-viewport rule (not under .dark) must not exist
    expect(css).not.toMatch(/^\s*\.xterm-viewport::-webkit-scrollbar\s*\{/m);
    expect(css).not.toMatch(/^\s*\.xterm-viewport\s*\{[^}]*scrollbar-color[^}]*#252525/ms);
  });

  it('root scrollbar keeps the light colors', () => {
    const rootScrollbar = blockFor('*::-webkit-scrollbar {');
    expect(rootScrollbar).toContain('#e8e8e8');
  });

  it('ocean scrollbar rules come after the ocean token block and use the ocean colors', () => {
    const oceanScrollbarStart = css.indexOf('.theme-ocean *::-webkit-scrollbar {');
    expect(oceanScrollbarStart).toBeGreaterThan(css.indexOf('.theme-ocean {'));
    expect(blockFor('.theme-ocean *::-webkit-scrollbar-track {')).toContain('#eaf1f5');
    expect(blockFor('.theme-ocean *::-webkit-scrollbar-thumb {')).toContain('#9aaebd');
    expect(blockFor('.theme-ocean *::-webkit-scrollbar-thumb:hover {')).toContain('#6d8293');
    expect(blockFor('.theme-ocean * {')).toContain('scrollbar-color: #9aaebd #eaf1f5;');
  });

  it('no dark !important overrides remain on xterm-viewport', () => {
    // !important on xterm-viewport was removed; dark scoping provides sufficient specificity
    expect(css).not.toMatch(/\.xterm-viewport[^{]*\{[^}]*!important/ms);
  });
});

// Layer: UI source-contract unit (Jest). The ratios are computed from the channels the
// stylesheet ships, so a token edit that breaks WCAG AA fails here before any screenshot.
describe('theme palette contrast', () => {
  const ocean = (name: string) => hslToRgb(variableValue(blockFor('.theme-ocean {'), name));
  const dark = (name: string) => hslToRgb(variableValue(blockFor('.dark {'), name));

  const textPairs: Array<[string, () => Rgb, () => Rgb]> = [
    ['foreground on background', () => ocean('foreground'), () => ocean('background')],
    ['muted-foreground on muted', () => ocean('muted-foreground'), () => ocean('muted')],
    ['muted-foreground on group', () => ocean('muted-foreground'), () => ocean('group')],
    ['muted-foreground on canvas', () => ocean('muted-foreground'), () => ocean('canvas')],
    ['primary-foreground on primary', () => ocean('primary-foreground'), () => ocean('primary')],
    [
      'selected-foreground on selected',
      () => ocean('selected-foreground'),
      () => ocean('selected'),
    ],
    [
      'destructive-foreground on destructive',
      () => ocean('destructive-foreground'),
      () => ocean('destructive'),
    ],
    ...['status-ok', 'status-warn', 'status-info', 'destructive-text'].flatMap(
      (tone): Array<[string, () => Rgb, () => Rgb]> => [
        [`${tone} on white`, () => ocean(tone), () => WHITE],
        [`${tone} on its 10% tint`, () => ocean(tone), () => tint(ocean(tone), 0.1)],
      ],
    ),
    ['dark status-info on the dark card', () => dark('status-info'), () => dark('card')],
    ...['background', 'card', 'muted'].map((surface): [string, () => Rgb, () => Rgb] => [
      `dark destructive-text on the dark ${surface}`,
      () => dark('destructive-text'),
      () => dark(surface),
    ]),
    [
      'dark destructive-text on its 10% tint over the dark card',
      () => dark('destructive-text'),
      () => tint(dark('destructive-text'), 0.1, dark('card')),
    ],
  ];

  it.each(textPairs)('%s is at least 4.5:1', (_label, text, surface) => {
    expect(contrast(text(), surface())).toBeGreaterThanOrEqual(4.5);
  });

  const graphicPairs: Array<[string, () => Rgb, () => Rgb]> = [
    ['input on white', () => ocean('input'), () => WHITE],
    ['input on group', () => ocean('input'), () => ocean('group')],
    ['switch-off track and its white thumb', () => ocean('switch-off'), () => WHITE],
  ];

  it.each(graphicPairs)('%s is at least 3:1', (_label, graphic, surface) => {
    expect(contrast(graphic(), surface())).toBeGreaterThanOrEqual(3);
  });
});

// Layer: build-config unit (Jest). One compile of every utility the tests below read;
// each compile builds a full Tailwind context, so the tests share it.
const COMPILED_UTILITIES = [
  'bg-status-ok/10 text-status-warn border-status-warn/40 bg-status-info/10',
  'bg-canvas bg-shell bg-group bg-selected text-selected-foreground bg-overlay bg-switch-off',
  'text-destructive text-destructive/80 text-destructive-foreground',
  'bg-destructive bg-destructive/10 border-destructive/40',
].join(' ');

let compiled: Promise<string> | undefined;

function compiledUtilities(): Promise<string> {
  compiled ??= (async () => {
    const postcss = (await import('postcss')).default;
    const tailwindcss = (await import('tailwindcss')).default;
    const configPath = path.resolve(__dirname, '../../../tailwind.config.js');
    const config = (await import(configPath)).default as Config;
    const result = await postcss([
      tailwindcss({ ...config, content: [{ raw: COMPILED_UTILITIES, extension: 'html' }] }),
    ]).process('@tailwind utilities;', { from: undefined });
    return result.css;
  })();
  return compiled;
}

describe('tailwind status colors', () => {
  it('accept opacity modifiers', async () => {
    const css = await compiledUtilities();
    expect(css).toMatch(
      /\.bg-status-ok\\\/10\s*\{\s*background-color: hsl\(var\(--status-ok\) \/ 0\.1\)/,
    );
    expect(css).toMatch(
      /\.border-status-warn\\\/40\s*\{\s*border-color: hsl\(var\(--status-warn\) \/ 0\.4\)/,
    );
    expect(css).toMatch(
      /\.text-status-warn\s*\{[^}]*color: hsl\(var\(--status-warn\) \/ var\(--tw-text-opacity/,
    );
    expect(css).toMatch(
      /\.bg-status-info\\\/10\s*\{\s*background-color: hsl\(var\(--status-info\) \/ 0\.1\)/,
    );
  });
});

describe('tailwind theme role colors', () => {
  it('maps each role to its variable', async () => {
    const css = await compiledUtilities();
    for (const [utility, variable] of [
      ['bg-canvas', 'canvas'],
      ['bg-shell', 'shell'],
      ['bg-group', 'group'],
      ['bg-selected', 'selected'],
      ['text-selected-foreground', 'selected-foreground'],
    ]) {
      expect(css).toMatch(new RegExp(`\\.${utility}\\s*\\{[^}]*hsl\\(var\\(--${variable}\\)`));
    }
  });

  it('keeps the alpha of overlay and switch-off inside the variable', async () => {
    const css = await compiledUtilities();
    expect(css).toMatch(/\.bg-overlay\s*\{\s*background-color: hsl\(var\(--overlay\)\);?\s*\}/);
    expect(css).toMatch(
      /\.bg-switch-off\s*\{\s*background-color: hsl\(var\(--switch-off\)\);?\s*\}/,
    );
  });

  it('points text-destructive at the text red and keeps fills, tints and borders on the fill red', async () => {
    const css = await compiledUtilities();
    expect(css).toMatch(
      /\.text-destructive\s*\{[^}]*color: hsl\(var\(--destructive-text\) \/ var\(--tw-text-opacity/,
    );
    expect(css).toMatch(
      /\.text-destructive\\\/80\s*\{\s*color: hsl\(var\(--destructive-text\) \/ 0\.8\)/,
    );
    expect(css).toMatch(
      /\.text-destructive-foreground\s*\{\s*color: hsl\(var\(--destructive-foreground\)\)/,
    );
    expect(css).toMatch(/\.bg-destructive\s*\{\s*background-color: hsl\(var\(--destructive\)\)/);
    expect(css).toMatch(
      /\.bg-destructive\\\/10\s*\{\s*background-color: hsl\(var\(--destructive\) \/ 0\.1\)/,
    );
    expect(css).toMatch(
      /\.border-destructive\\\/40\s*\{\s*border-color: hsl\(var\(--destructive\) \/ 0\.4\)/,
    );
  });
});
