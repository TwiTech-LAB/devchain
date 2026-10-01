import * as fs from 'fs';
import * as path from 'path';

const MARKDOWN_RENDERER_PATH = path.resolve(__dirname, '../../shared/MarkdownRenderer.tsx');

describe('MarkdownRenderer theme contract', () => {
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
