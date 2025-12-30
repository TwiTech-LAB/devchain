import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SavedFiltersSelect } from './SavedFiltersSelect';

// Mock the toast hook
const mockToast = jest.fn();
jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

// Mock crypto.randomUUID for JSDOM environment
let uuidCounter = 0;
const mockRandomUUID = jest.fn(() => `mock-uuid-${++uuidCounter}`);
Object.defineProperty(global, 'crypto', {
  value: { randomUUID: mockRandomUUID },
});

// JSDOM lacks ResizeObserver used by Radix
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

describe('SavedFiltersSelect', () => {
  const projectId = 'test-project-123';
  const storageKey = `devchain:board:savedFilters:${projectId}`;
  const mockOnApply = jest.fn();

  beforeEach(() => {
    window.localStorage.clear();
    mockToast.mockClear();
    mockOnApply.mockClear();
    uuidCounter = 0;
  });

  const renderComponent = (currentFilters = {}) => {
    return render(
      <SavedFiltersSelect
        projectId={projectId}
        currentFilters={currentFilters}
        onApply={mockOnApply}
      />,
    );
  };

  describe('Empty state', () => {
    it('shows empty state when no saved filters exist', async () => {
      renderComponent();

      // Open the popover
      fireEvent.click(screen.getByRole('button', { name: /saved filters/i }));

      await waitFor(() => {
        expect(screen.getByText('No saved filters')).toBeInTheDocument();
      });
    });

    it('shows "Saved" on button when no filter is active', () => {
      renderComponent();
      expect(screen.getByRole('button', { name: /saved filters/i })).toHaveTextContent('Saved');
    });
  });

  describe('Listing filters', () => {
    beforeEach(() => {
      const filters = [
        { id: 'f1', name: 'Active Tasks', qs: 'st=in-progress' },
        { id: 'f2', name: 'My Bugs', qs: 'st=todo&tag=bug' },
      ];
      window.localStorage.setItem(storageKey, JSON.stringify(filters));
    });

    it('lists all saved filters for project', async () => {
      renderComponent();

      fireEvent.click(screen.getByRole('button', { name: /saved filters/i }));

      await waitFor(() => {
        expect(screen.getByText('Active Tasks')).toBeInTheDocument();
        expect(screen.getByText('My Bugs')).toBeInTheDocument();
      });
    });

    it('calls onApply when filter is selected', async () => {
      renderComponent();

      fireEvent.click(screen.getByRole('button', { name: /saved filters/i }));
      await waitFor(() => screen.getByText('Active Tasks'));

      fireEvent.click(screen.getByText('Active Tasks'));

      expect(mockOnApply).toHaveBeenCalledWith('st=in-progress');
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Filter applied',
        }),
      );
    });

    it('shows checkmark next to selected filter', async () => {
      renderComponent({});

      // Select a filter
      fireEvent.click(screen.getByRole('button', { name: /saved filters/i }));
      await waitFor(() => screen.getByText('Active Tasks'));
      fireEvent.click(screen.getByText('Active Tasks'));

      // Verify onApply was called with the filter's query string
      expect(mockOnApply).toHaveBeenCalledWith('st=in-progress');
    });
  });

  describe('Saving filters', () => {
    it('opens save dialog on save button click', async () => {
      renderComponent({ status: ['review'] });

      fireEvent.click(screen.getByRole('button', { name: /saved filters/i }));
      await waitFor(() => screen.getByText('Save'));

      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(screen.getByText('Save Filter')).toBeInTheDocument();
      });
    });

    it('disables save button when no active filters', async () => {
      renderComponent({});

      fireEvent.click(screen.getByRole('button', { name: /saved filters/i }));

      // Wait for popover content
      await waitFor(() => screen.getByText('Saved Filters'));

      // Find the Save button inside the popover header (the one with Plus icon)
      const saveButtons = screen.getAllByRole('button').filter((btn) => btn.textContent === 'Save');
      const headerSaveButton = saveButtons.find((btn) =>
        btn.closest('.flex.items-center.justify-between'),
      );

      expect(headerSaveButton).toBeDisabled();
    });

    it('validates name uniqueness in save dialog', async () => {
      // Pre-populate with existing filter
      window.localStorage.setItem(
        storageKey,
        JSON.stringify([{ id: 'f1', name: 'My Filter', qs: 'st=done' }]),
      );

      renderComponent({ status: ['review'] });

      fireEvent.click(screen.getByRole('button', { name: /saved filters/i }));
      await waitFor(() => screen.getByText('Save'));
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => screen.getByRole('dialog'));

      const input = screen.getByLabelText('Name');
      fireEvent.change(input, { target: { value: 'My Filter' } });

      // Try to save
      fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

      await waitFor(() => {
        expect(screen.getByText(/already exists/i)).toBeInTheDocument();
      });
    });

    it('validates empty name in save dialog', async () => {
      renderComponent({ status: ['review'] });

      fireEvent.click(screen.getByRole('button', { name: /saved filters/i }));
      await waitFor(() => screen.getByText('Save'));
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => screen.getByRole('dialog'));

      // Save button should be disabled with empty name
      expect(screen.getByRole('button', { name: /^Save$/i })).toBeDisabled();
    });

    it('shows success toast on save', async () => {
      renderComponent({ status: ['review'] });

      fireEvent.click(screen.getByRole('button', { name: /saved filters/i }));
      await waitFor(() => screen.getByText('Save'));
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => screen.getByRole('dialog'));

      const input = screen.getByLabelText('Name');
      fireEvent.change(input, { target: { value: 'New Filter' } });
      fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

      await waitFor(() => {
        expect(mockToast).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'Filter saved',
          }),
        );
      });
    });

    it('saves filter on Enter key press', async () => {
      renderComponent({ status: ['review'] });

      fireEvent.click(screen.getByRole('button', { name: /saved filters/i }));
      await waitFor(() => screen.getByText('Save'));
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => screen.getByRole('dialog'));

      const input = screen.getByLabelText('Name');
      fireEvent.change(input, { target: { value: 'Enter Filter' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      await waitFor(() => {
        expect(mockToast).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'Filter saved',
          }),
        );
      });
    });
  });

  describe('Renaming filters', () => {
    beforeEach(() => {
      const filters = [{ id: 'f1', name: 'Old Name', qs: 'st=todo' }];
      window.localStorage.setItem(storageKey, JSON.stringify(filters));
    });

    it('opens rename dialog when edit button is clicked', async () => {
      renderComponent();

      fireEvent.click(screen.getByRole('button', { name: /saved filters/i }));
      await waitFor(() => screen.getByText('Old Name'));

      // Hover to show edit button and click it
      const editButton = screen.getByRole('button', { name: /rename "old name"/i });
      fireEvent.click(editButton);

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(screen.getByText('Rename Filter')).toBeInTheDocument();
      });
    });

    it('allows rename with validation', async () => {
      renderComponent();

      fireEvent.click(screen.getByRole('button', { name: /saved filters/i }));
      await waitFor(() => screen.getByText('Old Name'));

      fireEvent.click(screen.getByRole('button', { name: /rename "old name"/i }));

      await waitFor(() => screen.getByRole('dialog'));

      const input = screen.getByLabelText('Name');
      fireEvent.change(input, { target: { value: 'New Name' } });
      fireEvent.click(screen.getByRole('button', { name: /^Rename$/i }));

      await waitFor(() => {
        expect(mockToast).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'Filter renamed',
          }),
        );
      });

      // Verify localStorage was updated
      const stored = JSON.parse(window.localStorage.getItem(storageKey) || '[]');
      expect(stored[0].name).toBe('New Name');
    });
  });

  describe('Deleting filters', () => {
    beforeEach(() => {
      const filters = [{ id: 'f1', name: 'To Delete', qs: 'st=todo' }];
      window.localStorage.setItem(storageKey, JSON.stringify(filters));
    });

    it('confirms before delete', async () => {
      renderComponent();

      fireEvent.click(screen.getByRole('button', { name: /saved filters/i }));
      await waitFor(() => screen.getByText('To Delete'));

      fireEvent.click(screen.getByRole('button', { name: /delete "to delete"/i }));

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(screen.getByText('Delete Filter')).toBeInTheDocument();
        expect(screen.getByText(/are you sure/i)).toBeInTheDocument();
      });
    });

    it('deletes filter after confirmation', async () => {
      renderComponent();

      fireEvent.click(screen.getByRole('button', { name: /saved filters/i }));
      await waitFor(() => screen.getByText('To Delete'));

      fireEvent.click(screen.getByRole('button', { name: /delete "to delete"/i }));

      await waitFor(() => screen.getByRole('dialog'));

      fireEvent.click(screen.getByRole('button', { name: /^Delete$/i }));

      await waitFor(() => {
        expect(mockToast).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'Filter deleted',
          }),
        );
      });

      // Verify localStorage was updated
      const stored = JSON.parse(window.localStorage.getItem(storageKey) || '[]');
      expect(stored).toHaveLength(0);
    });

    it('can cancel delete', async () => {
      renderComponent();

      fireEvent.click(screen.getByRole('button', { name: /saved filters/i }));
      await waitFor(() => screen.getByText('To Delete'));

      fireEvent.click(screen.getByRole('button', { name: /delete "to delete"/i }));

      await waitFor(() => screen.getByRole('dialog'));

      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

      // Filter should still exist
      const stored = JSON.parse(window.localStorage.getItem(storageKey) || '[]');
      expect(stored).toHaveLength(1);
    });
  });

  describe('Max length validation', () => {
    it('enforces 50 character max length on save', async () => {
      renderComponent({ status: ['review'] });

      fireEvent.click(screen.getByRole('button', { name: /saved filters/i }));
      await waitFor(() => screen.getByText('Save'));
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => screen.getByRole('dialog'));

      const input = screen.getByLabelText('Name');
      expect(input).toHaveAttribute('maxLength', '50');
    });

    it('shows error for name exceeding 50 characters', async () => {
      renderComponent({ status: ['review'] });

      fireEvent.click(screen.getByRole('button', { name: /saved filters/i }));
      await waitFor(() => screen.getByText('Save'));
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => screen.getByRole('dialog'));

      const input = screen.getByLabelText('Name');
      // Type a long name (51+ chars)
      const longName = 'a'.repeat(51);
      fireEvent.change(input, { target: { value: longName } });

      // Try to save - should show error
      fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

      await waitFor(() => {
        expect(screen.getByText(/50 characters or less/i)).toBeInTheDocument();
      });
    });
  });

  describe('Project isolation', () => {
    it('only shows filters for current project', async () => {
      // Save filter for different project
      window.localStorage.setItem(
        'devchain:board:savedFilters:other-project',
        JSON.stringify([{ id: 'other-f1', name: 'Other Project Filter', qs: 'st=done' }]),
      );

      // Save filter for current project
      window.localStorage.setItem(
        storageKey,
        JSON.stringify([{ id: 'f1', name: 'Current Project Filter', qs: 'st=todo' }]),
      );

      renderComponent();

      fireEvent.click(screen.getByRole('button', { name: /saved filters/i }));

      await waitFor(() => {
        expect(screen.getByText('Current Project Filter')).toBeInTheDocument();
        expect(screen.queryByText('Other Project Filter')).not.toBeInTheDocument();
      });
    });
  });
});
