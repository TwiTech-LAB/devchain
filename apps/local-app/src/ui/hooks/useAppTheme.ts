import { useState, useEffect } from 'react';
import type { ThemeValue } from '@/ui/components/ThemeSelect';

function readThemeFromDOM(): ThemeValue {
  if (typeof document === 'undefined') return 'dark';
  const root = document.documentElement;
  if (root.classList.contains('theme-ocean')) return 'ocean';
  return 'dark';
}

export function useAppTheme(): ThemeValue {
  const [theme, setTheme] = useState<ThemeValue>(readThemeFromDOM);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(readThemeFromDOM());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, []);

  return theme;
}
