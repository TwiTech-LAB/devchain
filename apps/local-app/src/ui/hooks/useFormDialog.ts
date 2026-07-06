import { useCallback, useMemo, useState } from 'react';

/**
 * Headless dialog-state controllers for CRUD pages. No rendered markup — a page
 * keeps its own Dialog/ConfirmDialog JSX and drives it from these hooks. This
 * centralizes the create-vs-edit context, the reset-on-open/close ordering, and
 * the `onOpenChange` close-resets that every CRUD page hand-rolls today.
 *
 * `useFormDialog` owns the create/edit form dialog (optionally its field values
 * + field errors, for pages whose fields live at the page level). `useConfirmDialog`
 * owns the delete/confirm-target dialog. Two explicit controllers rather than one
 * boolean-mode hook, so intent stays legible at each call site.
 */

// ============================================
// useFormDialog — create / edit form dialog
// ============================================

export type FormDialogMode = 'closed' | 'create' | 'edit';

export interface UseFormDialogOptions<TEntity, TValues> {
  /** Initial field values when opening in create mode. Omit for child-owned fields. */
  createValues?: () => TValues;
  /** Initial field values when opening in edit mode for `entity`. Falls back to `createValues`. */
  editValues?: (entity: TEntity) => TValues;
}

export interface UseFormDialogResult<TEntity, TValues> {
  mode: FormDialogMode;
  isOpen: boolean;
  isCreate: boolean;
  isEdit: boolean;
  /** The entity being edited (null in create/closed). */
  entity: TEntity | null;

  /** Page-owned field values. `{}` when no value factories were supplied. */
  values: TValues;
  setValues: (updater: TValues | ((prev: TValues) => TValues)) => void;
  patchValues: (patch: Partial<TValues>) => void;

  fieldErrors: Record<string, string>;
  setFieldError: (field: string, message: string) => void;
  clearFieldError: (field: string) => void;
  clearFieldErrors: () => void;

  openCreate: () => void;
  openEdit: (entity: TEntity) => void;
  close: () => void;
  /** Radix-style handler: closes on `false`, ignores `true` (open via openCreate/openEdit). */
  onOpenChange: (open: boolean) => void;
}

interface FormDialogState<TEntity, TValues> {
  mode: FormDialogMode;
  entity: TEntity | null;
  values: TValues;
  fieldErrors: Record<string, string>;
}

export function useFormDialog<TEntity = unknown, TValues extends object = Record<string, never>>(
  options: UseFormDialogOptions<TEntity, TValues> = {},
): UseFormDialogResult<TEntity, TValues> {
  const { createValues, editValues } = options;

  // Kept in a single state object so every open/close transition is atomic and
  // its reset ordering is deterministic (values + errors reset together, never
  // in a torn intermediate render).
  const [state, setState] = useState<FormDialogState<TEntity, TValues>>(() => ({
    mode: 'closed',
    entity: null,
    values: createValues?.() ?? ({} as TValues),
    fieldErrors: {},
  }));

  const openCreate = useCallback(() => {
    setState({
      mode: 'create',
      entity: null,
      values: createValues?.() ?? ({} as TValues),
      fieldErrors: {},
    });
  }, [createValues]);

  const openEdit = useCallback(
    (entity: TEntity) => {
      setState({
        mode: 'edit',
        entity,
        values: editValues?.(entity) ?? createValues?.() ?? ({} as TValues),
        fieldErrors: {},
      });
    },
    [createValues, editValues],
  );

  const close = useCallback(() => {
    setState({
      mode: 'closed',
      entity: null,
      values: createValues?.() ?? ({} as TValues),
      fieldErrors: {},
    });
  }, [createValues]);

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open) close();
    },
    [close],
  );

  const setValues = useCallback((updater: TValues | ((prev: TValues) => TValues)) => {
    setState((prev) => ({
      ...prev,
      values:
        typeof updater === 'function'
          ? (updater as (prev: TValues) => TValues)(prev.values)
          : updater,
    }));
  }, []);

  const patchValues = useCallback((patch: Partial<TValues>) => {
    setState((prev) => ({ ...prev, values: { ...prev.values, ...patch } }));
  }, []);

  const setFieldError = useCallback((field: string, message: string) => {
    setState((prev) => ({ ...prev, fieldErrors: { ...prev.fieldErrors, [field]: message } }));
  }, []);

  const clearFieldError = useCallback((field: string) => {
    setState((prev) => {
      if (!(field in prev.fieldErrors)) return prev;
      const next = { ...prev.fieldErrors };
      delete next[field];
      return { ...prev, fieldErrors: next };
    });
  }, []);

  const clearFieldErrors = useCallback(() => {
    setState((prev) =>
      Object.keys(prev.fieldErrors).length === 0 ? prev : { ...prev, fieldErrors: {} },
    );
  }, []);

  return useMemo(
    () => ({
      mode: state.mode,
      isOpen: state.mode !== 'closed',
      isCreate: state.mode === 'create',
      isEdit: state.mode === 'edit',
      entity: state.entity,
      values: state.values,
      setValues,
      patchValues,
      fieldErrors: state.fieldErrors,
      setFieldError,
      clearFieldError,
      clearFieldErrors,
      openCreate,
      openEdit,
      close,
      onOpenChange,
    }),
    [
      state,
      setValues,
      patchValues,
      setFieldError,
      clearFieldError,
      clearFieldErrors,
      openCreate,
      openEdit,
      close,
      onOpenChange,
    ],
  );
}

// ============================================
// useConfirmDialog — delete / confirm target
// ============================================

export interface UseConfirmDialogResult<TEntity> {
  isOpen: boolean;
  /** The entity awaiting confirmation (null when closed). */
  target: TEntity | null;
  open: (target: TEntity) => void;
  close: () => void;
  /** Radix-style handler: closes (clears target) on `false`, ignores `true`. */
  onOpenChange: (open: boolean) => void;
}

export function useConfirmDialog<TEntity = unknown>(): UseConfirmDialogResult<TEntity> {
  const [target, setTarget] = useState<TEntity | null>(null);

  const open = useCallback((next: TEntity) => setTarget(next), []);
  const close = useCallback(() => setTarget(null), []);
  const onOpenChange = useCallback((next: boolean) => {
    if (!next) setTarget(null);
  }, []);

  return useMemo(
    () => ({ isOpen: target !== null, target, open, close, onOpenChange }),
    [target, open, close, onOpenChange],
  );
}
