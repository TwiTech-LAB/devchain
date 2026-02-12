import { Bot, Brain, Github } from 'lucide-react';

export interface SourceDisplay {
  icon: typeof Bot;
  label: string;
  className: string;
}

export const SOURCE_DISPLAY_BY_NAME: Record<string, SourceDisplay> = {
  openai: {
    icon: Bot,
    label: 'OpenAI',
    className: 'text-emerald-700',
  },
  anthropic: {
    icon: Brain,
    label: 'Anthropic',
    className: 'text-orange-700',
  },
};

export function getSourceDisplay(source: string): SourceDisplay {
  const normalized = source.trim().toLowerCase();
  if (normalized in SOURCE_DISPLAY_BY_NAME) {
    return SOURCE_DISPLAY_BY_NAME[normalized];
  }

  return {
    icon: Github,
    label: source,
    className: 'text-slate-700',
  };
}
