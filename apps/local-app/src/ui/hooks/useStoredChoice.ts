import { useCallback, useState } from 'react';

function readStoredChoice<T extends string>(key: string, choices: readonly T[], fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    if (stored !== null && (choices as readonly string[]).includes(stored)) return stored as T;
  } catch {
    // localStorage unavailable
  }
  return fallback;
}

/**
 * A display preference of this browser. An unknown or unreadable stored value gives
 * `fallback`; a failed write keeps the choice for this page only.
 */
export function useStoredChoice<T extends string>(
  key: string,
  choices: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const [choice, setChoiceState] = useState<T>(() => readStoredChoice(key, choices, fallback));
  const setChoice = useCallback(
    (next: T) => {
      setChoiceState(next);
      try {
        localStorage.setItem(key, next);
      } catch {
        // localStorage unavailable
      }
    },
    [key],
  );
  return [choice, setChoice];
}
