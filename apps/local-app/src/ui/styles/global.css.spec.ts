import fs from 'fs';
import path from 'path';

const cssPath = path.resolve(__dirname, 'global.css');
const css = fs.readFileSync(cssPath, 'utf-8');

function blockFor(selector: string): string {
  const start = css.indexOf(selector);
  expect(start).toBeGreaterThan(-1);
  const rest = css.slice(start);
  const end = rest.indexOf('}\n');
  expect(end).toBeGreaterThan(-1);
  return rest.slice(0, end);
}

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
    'terminal-background',
    'terminal-foreground',
    'terminal-cursor',
    'terminal-selection',
    'terminal-selection-opacity',
  ];

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
