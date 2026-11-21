import { MarkdownRenderer } from '@/ui/components/shared/MarkdownRenderer';
import type { SetupPreviewResponse } from '@/ui/pages/projects/lib/project-contracts';

export const HOW_IT_WORKS_TAG = 'template:how-it-works';

/**
 * The content of the template's first prompt tagged {@link HOW_IT_WORKS_TAG}, or null when there is
 * none or its content is empty.
 */
export function findHowItWorksGuide(payload: SetupPreviewResponse['payload']): string | null {
  const prompt = (payload.prompts ?? []).find((p) => (p.tags ?? []).includes(HOW_IT_WORKS_TAG));
  return prompt?.content.trim() ? prompt.content : null;
}

/** The guide as plain Markdown: template variables are shown as written, never rendered. */
export function HowItWorks({ content }: { content: string }) {
  return (
    <div data-testid="wizard-how-it-works">
      <MarkdownRenderer content={content} />
    </div>
  );
}
