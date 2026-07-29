import { readFileSync } from 'fs';
import { join } from 'path';
import { ExportSchema } from '@devchain/shared';

const TEMPLATE_NAMES = ['3-agents-dev.json', 'teams-dev.json'] as const;

describe.each(TEMPLATE_NAMES)('%s provider settings', (templateName) => {
  const loadTemplate = () => {
    const path = join(__dirname, '../../../../templates', templateName);
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  };

  it('exports only the surviving Claude provider settings', () => {
    const parsed = ExportSchema.parse(loadTemplate());

    expect(parsed.providerSettings).toEqual([{ name: 'claude', autoCompactThreshold: 95 }]);
  });

  it('preserves the GLM config boundary exactly', () => {
    const template = loadTemplate() as {
      profiles: Array<{
        providerConfigs?: Array<{
          name: string;
          env?: Record<string, string> | null;
        }>;
      }>;
    };
    const glmConfig = template.profiles
      .flatMap((profile) => profile.providerConfigs ?? [])
      .find(
        (config) =>
          config.name === 'glm' && config.env?.ANTHROPIC_DEFAULT_OPUS_MODEL === 'glm-5.2[1m]',
      );

    expect(glmConfig?.env).toMatchObject({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2[1m]',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '450000',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '95',
    });
  });
});
