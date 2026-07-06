import { renderHook, act } from '@testing-library/react';
import { useConfirmDialog, useFormDialog } from './useFormDialog';

interface Entity {
  id: string;
  name: string;
}

interface Values {
  name: string;
  count: number;
}

describe('useFormDialog', () => {
  describe('open/close context', () => {
    it('starts closed', () => {
      const { result } = renderHook(() => useFormDialog<Entity>());
      expect(result.current.mode).toBe('closed');
      expect(result.current.isOpen).toBe(false);
      expect(result.current.isCreate).toBe(false);
      expect(result.current.isEdit).toBe(false);
      expect(result.current.entity).toBeNull();
    });

    it('openCreate enters create mode with no entity', () => {
      const { result } = renderHook(() => useFormDialog<Entity>());
      act(() => result.current.openCreate());
      expect(result.current.mode).toBe('create');
      expect(result.current.isCreate).toBe(true);
      expect(result.current.isOpen).toBe(true);
      expect(result.current.entity).toBeNull();
    });

    it('openEdit enters edit mode carrying the entity', () => {
      const { result } = renderHook(() => useFormDialog<Entity>());
      const entity = { id: 't1', name: 'Alpha' };
      act(() => result.current.openEdit(entity));
      expect(result.current.mode).toBe('edit');
      expect(result.current.isEdit).toBe(true);
      expect(result.current.entity).toBe(entity);
    });

    it('close returns to closed and drops the entity', () => {
      const { result } = renderHook(() => useFormDialog<Entity>());
      act(() => result.current.openEdit({ id: 't1', name: 'Alpha' }));
      act(() => result.current.close());
      expect(result.current.mode).toBe('closed');
      expect(result.current.entity).toBeNull();
    });

    it('onOpenChange(false) closes; onOpenChange(true) is a no-op', () => {
      const { result } = renderHook(() => useFormDialog<Entity>());
      act(() => result.current.openCreate());
      act(() => result.current.onOpenChange(true));
      expect(result.current.isCreate).toBe(true); // still open — opening is explicit
      act(() => result.current.onOpenChange(false));
      expect(result.current.mode).toBe('closed');
    });
  });

  describe('values + reset-on-open/close ordering', () => {
    const createValues = (): Values => ({ name: '', count: 0 });
    const editValues = (e: Entity): Values => ({ name: e.name, count: 1 });

    it('seeds create values on openCreate', () => {
      const { result } = renderHook(() =>
        useFormDialog<Entity, Values>({ createValues, editValues }),
      );
      act(() => result.current.openCreate());
      expect(result.current.values).toEqual({ name: '', count: 0 });
    });

    it('seeds edit values from the entity on openEdit', () => {
      const { result } = renderHook(() =>
        useFormDialog<Entity, Values>({ createValues, editValues }),
      );
      act(() => result.current.openEdit({ id: 't1', name: 'Alpha' }));
      expect(result.current.values).toEqual({ name: 'Alpha', count: 1 });
    });

    it('falls back to createValues when editValues is not supplied', () => {
      const { result } = renderHook(() => useFormDialog<Entity, Values>({ createValues }));
      act(() => result.current.openEdit({ id: 't1', name: 'Alpha' }));
      expect(result.current.values).toEqual({ name: '', count: 0 });
    });

    it('patchValues merges; setValues replaces', () => {
      const { result } = renderHook(() => useFormDialog<Entity, Values>({ createValues }));
      act(() => result.current.openCreate());
      act(() => result.current.patchValues({ name: 'Beta' }));
      expect(result.current.values).toEqual({ name: 'Beta', count: 0 });
      act(() => result.current.setValues({ name: 'Gamma', count: 9 }));
      expect(result.current.values).toEqual({ name: 'Gamma', count: 9 });
    });

    it('reset-on-open: reopening create re-seeds values and clears prior edits', () => {
      const { result } = renderHook(() =>
        useFormDialog<Entity, Values>({ createValues, editValues }),
      );
      act(() => result.current.openCreate());
      act(() => result.current.patchValues({ name: 'dirty', count: 5 }));
      act(() => result.current.openEdit({ id: 't2', name: 'Delta' }));
      // Reopening in a new mode re-seeds — the prior create edits are gone.
      expect(result.current.values).toEqual({ name: 'Delta', count: 1 });
    });

    it('reset-on-close: closing re-seeds create values and clears field errors together', () => {
      const { result } = renderHook(() =>
        useFormDialog<Entity, Values>({ createValues, editValues }),
      );
      act(() => result.current.openEdit({ id: 't1', name: 'Alpha' }));
      act(() => {
        result.current.patchValues({ name: 'edited' });
        result.current.setFieldError('name', 'bad');
      });
      act(() => result.current.close());
      expect(result.current.values).toEqual({ name: '', count: 0 });
      expect(result.current.fieldErrors).toEqual({});
    });

    it('defaults values to {} when no factories are supplied', () => {
      const { result } = renderHook(() => useFormDialog<Entity>());
      act(() => result.current.openCreate());
      expect(result.current.values).toEqual({});
    });
  });

  describe('field errors', () => {
    it('sets, clears one, and clears all', () => {
      const { result } = renderHook(() => useFormDialog<Entity>());
      act(() => result.current.openCreate());
      act(() => {
        result.current.setFieldError('name', 'required');
        result.current.setFieldError('lead', 'missing');
      });
      expect(result.current.fieldErrors).toEqual({ name: 'required', lead: 'missing' });
      act(() => result.current.clearFieldError('name'));
      expect(result.current.fieldErrors).toEqual({ lead: 'missing' });
      act(() => result.current.clearFieldErrors());
      expect(result.current.fieldErrors).toEqual({});
    });

    it('opening a dialog clears stale field errors', () => {
      const { result } = renderHook(() => useFormDialog<Entity>());
      act(() => result.current.openCreate());
      act(() => result.current.setFieldError('name', 'required'));
      act(() => result.current.openEdit({ id: 't1', name: 'Alpha' }));
      expect(result.current.fieldErrors).toEqual({});
    });
  });
});

describe('useConfirmDialog', () => {
  it('starts closed with no target', () => {
    const { result } = renderHook(() => useConfirmDialog<Entity>());
    expect(result.current.isOpen).toBe(false);
    expect(result.current.target).toBeNull();
  });

  it('open captures the target; close clears it', () => {
    const { result } = renderHook(() => useConfirmDialog<Entity>());
    const target = { id: 't1', name: 'Alpha' };
    act(() => result.current.open(target));
    expect(result.current.isOpen).toBe(true);
    expect(result.current.target).toBe(target);
    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
    expect(result.current.target).toBeNull();
  });

  it('onOpenChange(false) clears the target; onOpenChange(true) is a no-op', () => {
    const { result } = renderHook(() => useConfirmDialog<Entity>());
    act(() => result.current.open({ id: 't1', name: 'Alpha' }));
    act(() => result.current.onOpenChange(true));
    expect(result.current.isOpen).toBe(true);
    act(() => result.current.onOpenChange(false));
    expect(result.current.target).toBeNull();
  });
});
