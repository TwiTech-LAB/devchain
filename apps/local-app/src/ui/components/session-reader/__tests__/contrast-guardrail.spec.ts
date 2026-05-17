import * as fs from 'fs';
import * as path from 'path';

const SESSION_READER_DIR = path.resolve(__dirname, '..');
const SHARED_DIR = path.resolve(__dirname, '../../shared');
const MARKDOWN_RENDERER_PATH = path.join(SHARED_DIR, 'MarkdownRenderer.tsx');

/**
 * Heuristic: a line containing text-muted-foreground/{40,50,60} is a violation
 * unless the element's visible content is a pure separator character (·).
 *
 * text-muted-foreground/70 is allowed everywhere (meta-tier, ratified).
 */
const FORBIDDEN_OPACITY_RE = /text-muted-foreground\/(?:40|50|60)/;

/**
 * A line is a pure separator if its only visible text content is · (middle dot)
 * or whitespace. We extract the text between the last `>` and `</` closing tag.
 */
function isSeparatorOnlyLine(line: string): boolean {
  const match = line.match(/>([^<]*)<\/\w/);
  if (!match) return false;
  const textContent = match[1].trim();
  return textContent === '' || textContent === '·' || /^[\s·]+$/.test(textContent);
}

/** Known pre-existing exceptions — pre-T1/T2/T3 code, tracked for follow-up cleanup. */
const KNOWN_EXCEPTIONS = new Set([
  // SubagentItem — duration badge not in T2 explicit scope
  'SubagentItem.tsx:36',
  // SessionMetricsHeader — diagnostic metrics bar; intentionally excluded per task spec
  'SessionMetricsHeader.tsx:49',
  'SessionMetricsHeader.tsx:53',
  'SessionMetricsHeader.tsx:120',
  'SessionMetricsHeader.tsx:162',
  'SessionMetricsHeader.tsx:172',
  'SessionMetricsHeader.tsx:182',
  // InlineSessionSummaryChip — summary overlay, not in session-reader hierarchy scope
  'InlineSessionSummaryChip.tsx:261',
  // ToolGroupItem — T5 parallel task, not yet uplifted
  'ToolGroupItem.tsx:77',
  'ToolGroupItem.tsx:90',
]);

function collectTsxFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      results.push(...collectTsxFiles(fullPath));
    } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
      if (entry.name.includes('.spec.') || entry.name.includes('.test.')) continue;
      results.push(fullPath);
    }
  }
  return results;
}

describe('Opacity-ladder guardrail (T4)', () => {
  const files = collectTsxFiles(SESSION_READER_DIR);

  it('has at least one file to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no text-bearing element uses text-muted-foreground/{40,50,60}', () => {
    const violations: string[] = [];

    for (const filePath of files) {
      const relativePath = path.relative(SESSION_READER_DIR, filePath);
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!FORBIDDEN_OPACITY_RE.test(line)) continue;

        // Allow pure separator spans (·)
        if (isSeparatorOnlyLine(line)) continue;

        // Check known exceptions
        const lineKey = `${relativePath}:${i + 1}`;
        if (KNOWN_EXCEPTIONS.has(lineKey)) continue;

        violations.push(
          `${relativePath}:${i + 1} uses ${line.match(FORBIDDEN_OPACITY_RE)![0]} on text-bearing element. ` +
            `Use text-muted-foreground (full) for trace tier or /70 for meta tier.`,
        );
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Opacity-ladder violations found:\n${violations.map((v) => `  - ${v}`).join('\n')}`,
      );
    }
  });

  it('fails when a deliberate /50 is introduced on text content', () => {
    const fakeLine =
      '          <span className="text-muted-foreground/50 text-[10px]">some text</span>';
    expect(FORBIDDEN_OPACITY_RE.test(fakeLine)).toBe(true);
    expect(isSeparatorOnlyLine(fakeLine)).toBe(false);
  });
});

describe('MarkdownRenderer dark-mode static-scan guardrail (T4)', () => {
  it('MarkdownRenderer wrapper carries dark:prose-invert in source', () => {
    const source = fs.readFileSync(MARKDOWN_RENDERER_PATH, 'utf-8');
    expect(source).toMatch(/dark:prose-invert/);
    expect(source).toMatch(/prose prose-sm max-w-none/);
  });

  it('MarkdownRenderer does NOT contain text-muted-foreground in generated HTML pipeline', () => {
    const source = fs.readFileSync(MARKDOWN_RENDERER_PATH, 'utf-8');
    expect(source).not.toMatch(/text-muted-foreground/);
  });
});
