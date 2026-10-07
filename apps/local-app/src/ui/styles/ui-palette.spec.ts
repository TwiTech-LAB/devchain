import fs from 'fs';
import path from 'path';

const UI_ROOT = path.resolve(__dirname, '..');
const CATEGORY_PALETTES: Record<string, string> = {
  'lib/workspace-identity.ts': 'Stable workspace identity colors distinguish workspaces.',
  'lib/skills.ts': 'Skill category colors distinguish skill types.',
  'components/skills/source-display.ts': 'Source identity colors distinguish skill providers.',
};

const RAW_PALETTE =
  /(?<![\w-])(?:[\w-]+:)*(?:text|bg|border(?:-[xytrblse])?|ring|ring-offset|outline|divide|fill|stroke|from|via|to|decoration|shadow|placeholder|accent|caret)-(?:red|rose|orange|amber|yellow|lime|green|emerald|blue|sky|gray|slate|zinc|neutral|stone)-\d{2,3}(?:\/\d+)?(?![\w-])/g;
const FADED_TEXT =
  /(?<![\w-])(?:[\w-]+:)*text-(?:foreground|muted-foreground|primary)\/\d+(?![\w-])/g;

function sourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.(?:spec|test)\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

// Source inspection is the cheapest layer that covers every utility declaration,
// including conditional classes and files that no rendered fixture currently uses.
describe('UI theme palette contract', () => {
  it('rejects each raw hue with variants and opacity', () => {
    for (const hue of [
      'red',
      'rose',
      'orange',
      'amber',
      'yellow',
      'lime',
      'green',
      'emerald',
      'blue',
      'sky',
      'gray',
      'slate',
      'zinc',
      'neutral',
      'stone',
    ]) {
      const sample = `text-${hue}-600 hover:bg-${hue}-500/10 dark:focus:border-l-${hue}-400/40`;
      expect(sample.match(RAW_PALETTE)).toEqual(sample.split(' '));
    }
  });

  it('rejects each raw color utility', () => {
    for (const utility of [
      'text',
      'bg',
      'border',
      'border-x',
      'border-y',
      'border-t',
      'border-r',
      'border-b',
      'border-l',
      'border-s',
      'border-e',
      'ring',
      'ring-offset',
      'outline',
      'divide',
      'fill',
      'stroke',
      'from',
      'via',
      'to',
      'decoration',
      'shadow',
      'placeholder',
      'accent',
      'caret',
    ]) {
      expect(`${utility}-amber-600`.match(RAW_PALETTE)).toEqual([`${utility}-amber-600`]);
    }
  });

  it('rejects faded role text with variants', () => {
    for (const role of ['foreground', 'muted-foreground', 'primary']) {
      const sample = `text-${role}/60 dark:hover:text-${role}/70`;
      expect(sample.match(FADED_TEXT)).toEqual(sample.split(' '));
    }
  });

  it('allows role tokens, muted fills and the unrestricted category hues', () => {
    const sample = [
      'text-destructive',
      'bg-status-warn/10',
      'bg-selected',
      'border-status-ok/40',
      'text-primary',
      'text-foreground',
      'text-muted-foreground',
      'bg-muted/60',
      'text-purple-400',
      'text-violet-500',
      'text-fuchsia-600',
      'text-indigo-700',
      'text-teal-500',
      'text-cyan-600',
      'text-pink-500',
    ].join(' ');
    expect(sample.match(RAW_PALETTE)).toBeNull();
    expect(sample.match(FADED_TEXT)).toBeNull();
  });

  const files = sourceFiles(UI_ROOT);

  it('scans components, pages and utility modules', () => {
    const relativePaths = files.map((file) => path.relative(UI_ROOT, file));
    expect(relativePaths).toEqual(
      expect.arrayContaining(['components/Layout.tsx', 'pages/ChatPage.tsx', 'lib/utils.ts']),
    );
    expect(relativePaths.some((file) => /\.(?:spec|test)\.tsx?$/.test(file))).toBe(false);
  });

  it.each(Object.entries(CATEGORY_PALETTES))(
    'keeps the %s exception only while it contains a category palette (%s)',
    (relativePath) => {
      expect(
        fs.readFileSync(path.join(UI_ROOT, relativePath), 'utf-8').match(RAW_PALETTE),
      ).not.toBeNull();
    },
  );

  it('uses theme tokens and full-opacity text throughout UI sources', () => {
    const offenders = files.flatMap((file) => {
      const relativePath = path.relative(UI_ROOT, file);
      return fs
        .readFileSync(file, 'utf-8')
        .split('\n')
        .flatMap((line, index) => {
          const raw = Object.hasOwn(CATEGORY_PALETTES, relativePath)
            ? []
            : (line.match(RAW_PALETTE) ?? []);
          return [...raw, ...(line.match(FADED_TEXT) ?? [])].map(
            (match) => `${relativePath}:${index + 1} ${match}`,
          );
        });
    });
    expect(offenders).toEqual([]);
  });
});
