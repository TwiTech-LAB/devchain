import { useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Syncs an active key with a URL search param. Validates against allowed keys,
 * falls back to defaultKey, and canonicalizes the URL (replaces invalid key
 * with default while preserving other params).
 *
 * Key validation is derived during render (not via useEffect) per the
 * rerender-derived-state pattern. Only URL canonicalization is a side effect.
 */
export function useSubNavSearchParam<K extends string>(
  allowedKeys: K[],
  defaultKey: K,
  paramName: string,
): [K, (key: K) => void] {
  const [searchParams, setSearchParams] = useSearchParams();

  // Derive active key during render (rerender-derived-state pattern)
  const rawParam = searchParams.get(paramName);
  const isValid = rawParam !== null && (allowedKeys as string[]).includes(rawParam);
  const activeKey: K = isValid ? (rawParam as K) : defaultKey;

  // Canonicalize URL: replace invalid/unknown param value with default.
  // Only fires when param is present but not in allowedKeys.
  // Missing param (null) is left alone — we just use defaultKey silently.
  useEffect(() => {
    if (rawParam === null || isValid) return;
    const next = new URLSearchParams(searchParams);
    next.set(paramName, defaultKey);
    setSearchParams(next, { replace: true });
  }, [rawParam, isValid, paramName, defaultKey, searchParams, setSearchParams]);

  const setActiveKey = useCallback(
    (key: K) => {
      const next = new URLSearchParams(searchParams);
      next.set(paramName, key);
      setSearchParams(next);
    },
    [searchParams, setSearchParams, paramName],
  );

  return [activeKey, setActiveKey];
}
