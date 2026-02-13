import { Bot, Brain, FolderOpen, Github } from 'lucide-react';
import type { SkillSourceKind } from '@/ui/lib/skills';

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

export function getSourceDisplay(source: string, kind?: SkillSourceKind): SourceDisplay {
  if (kind === 'local') {
    return {
      icon: FolderOpen,
      label: source,
      className: 'text-indigo-700',
    };
  }

  const normalized = source.trim().toLowerCase();
  if (normalized in SOURCE_DISPLAY_BY_NAME) {
    return SOURCE_DISPLAY_BY_NAME[normalized];
  }

  if (kind === 'builtin') {
    return {
      icon: Bot,
      label: source,
      className: 'text-sky-700',
    };
  }

  return {
    icon: Github,
    label: source,
    className: 'text-slate-700',
  };
}
