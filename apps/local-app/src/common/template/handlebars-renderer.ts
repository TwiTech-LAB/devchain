import Handlebars from 'handlebars';

const LEGACY_TOKEN_REGEX = /(?<!\{)\{([a-z_]+)(\?)?\}(?!\})/gi;

function preprocessLegacyTokens(template: string, legacyVariables: string[]): string {
  const allowed = new Set(legacyVariables.map((v) => v.toLowerCase()));

  return template.replace(LEGACY_TOKEN_REGEX, (match, name: string) => {
    if (allowed.has(name.toLowerCase())) {
      return `{{${name.toLowerCase()}}}`;
    }
    return match;
  });
}

export function renderTemplate(
  template: string,
  vars: Record<string, unknown>,
  legacyVariables?: string[],
): string {
  let source = template;
  if (legacyVariables && legacyVariables.length > 0) {
    source = preprocessLegacyTokens(source, legacyVariables);
  }

  const compiled = Handlebars.compile(source, { noEscape: true });
  return compiled(vars);
}
