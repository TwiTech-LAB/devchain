import { renderTemplate } from '../../../common/template/handlebars-renderer';

export type TemplateReadinessResult = { ready: true } | { ready: false; reason: string };

export function checkTemplateReady(
  template: string,
  sampleVars?: Record<string, unknown>,
): TemplateReadinessResult {
  try {
    renderTemplate(template, sampleVars ?? {});
    return { ready: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Template render failed';
    return { ready: false, reason };
  }
}

export function renderScheduledEpicTemplate(
  template: string,
  vars: Record<string, unknown>,
): string {
  return renderTemplate(template, vars);
}
