/**
 * @deprecated Use ThemeSelect from './ThemeSelect' instead.
 * This alias will be removed in a future release.
 */
import { useEffect } from 'react';
import {
  ThemeSelect,
  type ThemeSelectProps,
  type ThemeValue,
  getStoredTheme,
  applyTheme,
} from './ThemeSelect';

export type { ThemeValue };
export { getStoredTheme, applyTheme };

export interface ThemeToggleProps extends ThemeSelectProps {}

export function ThemeToggle(props: ThemeToggleProps) {
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.warn('[Deprecation] ThemeToggle is deprecated; use ThemeSelect instead.');
    }
  }, []);
  return <ThemeSelect {...props} />;
}
