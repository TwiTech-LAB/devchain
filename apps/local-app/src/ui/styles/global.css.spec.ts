import fs from 'fs';
import path from 'path';

const cssPath = path.resolve(__dirname, 'global.css');
const css = fs.readFileSync(cssPath, 'utf-8');
const eventBusCss = fs.readFileSync(
  path.resolve(__dirname, '../components/chat/agent-event-bus/agent-event-bus.css'),
  'utf-8',
);

function blockFor(selector: string): string {
  const start = css.indexOf(selector);
  expect(start).toBeGreaterThan(-1);
  const rest = css.slice(start);
  const end = rest.indexOf('}\n');
  expect(end).toBeGreaterThan(-1);
  return rest.slice(0, end);
}

function variableValue(block: string, variableName: string): string {
  const match = block.match(new RegExp(`--${variableName}:\\s*([^;]+);`));
  expect(match).not.toBeNull();
  return match?.[1].trim() ?? '';
}

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

  it('keeps ocean agent-message cyan distinct from the ambient primary blue', () => {
    const oceanBlock = blockFor('.theme-ocean {');
    expect(variableValue(oceanBlock, 'event-bus-agent-message')).not.toBe(
      variableValue(oceanBlock, 'primary'),
    );
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

  it('root scrollbar uses light colors so ocean xterm inherits them', () => {
    const rootScrollbar = blockFor('*::-webkit-scrollbar {');
    expect(rootScrollbar).toContain('#e8e8e8');
  });

  it('no dark !important overrides remain on xterm-viewport', () => {
    // !important on xterm-viewport was removed; dark scoping provides sufficient specificity
    expect(css).not.toMatch(/\.xterm-viewport[^{]*\{[^}]*!important/ms);
  });
});
