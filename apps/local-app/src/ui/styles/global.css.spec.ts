import fs from 'fs';
import path from 'path';

describe('global.css theme variable completeness', () => {
  const cssPath = path.resolve(__dirname, 'global.css');
  const css = fs.readFileSync(cssPath, 'utf-8');

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

  function blockFor(selector: string) {
    const start = css.indexOf(selector);
    expect(start).toBeGreaterThan(-1);
    const rest = css.slice(start);
    const end = rest.indexOf('}\n');
    expect(end).toBeGreaterThan(-1);
    return rest.slice(0, end);
  }

  it('dark defines full variable set', () => {
    const darkBlock = blockFor('.dark {');
    for (const v of requiredVars) {
      expect(darkBlock).toContain(`--${v}:`);
    }
  });

  it('theme-ocean defines full variable set', () => {
    const oceanBlock = blockFor('.theme-ocean {');
    for (const v of requiredVars) {
      expect(oceanBlock).toContain(`--${v}:`);
    }
  });
});
