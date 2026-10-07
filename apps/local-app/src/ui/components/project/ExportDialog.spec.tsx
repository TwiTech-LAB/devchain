import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExportDialog } from './ExportDialog';

// ResizeObserver mock for Radix components (ScrollArea)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock useToast
const mockToast = jest.fn();
jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock URL.createObjectURL and URL.revokeObjectURL
const mockCreateObjectURL = jest.fn(() => 'blob:mock-url');
const mockRevokeObjectURL = jest.fn();
global.URL.createObjectURL = mockCreateObjectURL;
global.URL.revokeObjectURL = mockRevokeObjectURL;

// Mock document.createElement for download
const mockClick = jest.fn();
const originalCreateElement = document.createElement.bind(document);
jest.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
  if (tagName === 'a') {
    return {
      href: '',
      download: '',
      click: mockClick,
    } as unknown as HTMLAnchorElement;
  }
  return originalCreateElement(tagName);
});

describe('ExportDialog', () => {
  const defaultProps = {
    projectId: 'project-123',
    projectName: 'Test Project',
    open: true,
    onClose: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ _manifest: {}, version: 1 }),
    });
  });

  describe('rendering', () => {
    it('pre-fills fields with project name and slugified version', () => {
      render(<ExportDialog {...defaultProps} />);

      expect(screen.getByLabelText('Slug')).toHaveValue('test-project');
      expect(screen.getByLabelText('Name')).toHaveValue('Test Project');
    });

    it('uses existing manifest values when provided', () => {
      render(
        <ExportDialog
          {...defaultProps}
          existingManifest={{
            slug: 'existing-slug',
            name: 'Existing Name',
            description: 'Existing description',
            category: 'planning',
            tags: ['tag1', 'tag2'],
            version: '2.0.0',
            authorName: 'Test Author',
          }}
        />,
      );

      expect(screen.getByLabelText('Slug')).toHaveValue('existing-slug');
      expect(screen.getByLabelText('Name')).toHaveValue('Existing Name');
      expect(screen.getByLabelText('Description')).toHaveValue('Existing description');
      expect(screen.getByLabelText('Author')).toHaveValue('Test Author');
      // Version should be bumped
      expect(screen.getByLabelText('Version')).toHaveValue('2.0.1');
      // Tags should be displayed
      expect(screen.getByText('tag1')).toBeInTheDocument();
      expect(screen.getByText('tag2')).toBeInTheDocument();
    });
  });

  describe('version bumping', () => {
    it('suggests patch bump by default', () => {
      render(<ExportDialog {...defaultProps} existingManifest={{ version: '1.2.3' }} />);

      expect(screen.getByLabelText('Version')).toHaveValue('1.2.4');
    });

    it.each([
      { kind: 'Minor', expected: '1.3.0' },
      { kind: 'Major', expected: '2.0.0' },
    ] as const)('bumps $kind version', async ({ kind, expected }) => {
      render(<ExportDialog {...defaultProps} existingManifest={{ version: '1.2.3' }} />);
      await userEvent.click(screen.getByRole('button', { name: kind }));
      expect(screen.getByLabelText('Version')).toHaveValue(expected);
    });
  });

  describe('tag management', () => {
    it.each([
      { label: 'Add button', suffix: '', click: true, tag: 'new-tag' },
      { label: 'Enter key', suffix: '{enter}', click: false, tag: 'enter-tag' },
    ] as const)('adds tag through $label', async ({ suffix, click, tag }) => {
      render(<ExportDialog {...defaultProps} />);
      await userEvent.type(screen.getByLabelText('Tags'), tag + suffix);
      if (click) await userEvent.click(screen.getByRole('button', { name: 'Add' }));
      expect(screen.getByText(tag)).toBeInTheDocument();
    });

    // Note: Tag removal is tested via unit test of the handler function
    // The UI interaction is complex due to Badge component structure

    it('does not add duplicate tags', async () => {
      render(<ExportDialog {...defaultProps} existingManifest={{ tags: ['existing'] }} />);

      const tagInput = screen.getByLabelText('Tags');
      await userEvent.type(tagInput, 'existing');

      const addButton = screen.getByRole('button', { name: 'Add' });
      await userEvent.click(addButton);

      // Should only have one instance
      expect(screen.getAllByText('existing')).toHaveLength(1);
    });
  });

  // Note: Export functionality uses POST /api/projects/:id/export with manifest overrides
  // Full integration tests recommended for async fetch/download behavior

  describe('cancel functionality', () => {
    it('calls onClose when Cancel is clicked', async () => {
      const onClose = jest.fn();
      render(<ExportDialog {...defaultProps} onClose={onClose} />);

      const cancelButton = screen.getByRole('button', { name: 'Cancel' });
      await userEvent.click(cancelButton);

      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('minDevchainVersion field', () => {
    it('pre-fills minDevchainVersion from existing manifest', () => {
      render(<ExportDialog {...defaultProps} existingManifest={{ minDevchainVersion: '0.4.0' }} />);

      expect(screen.getByLabelText('Min Devchain Version')).toHaveValue('0.4.0');
    });

    it('shows validation error for invalid semver', async () => {
      render(<ExportDialog {...defaultProps} />);

      const input = screen.getByLabelText('Min Devchain Version');
      await userEvent.type(input, 'invalid-version');

      expect(screen.getByText(/Invalid version format/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Export/i })).toBeDisabled();
    });

    it('enables Export button when minDevchainVersion is empty (optional field)', () => {
      render(<ExportDialog {...defaultProps} />);

      // Empty by default
      expect(screen.getByLabelText('Min Devchain Version')).toHaveValue('');

      const exportButton = screen.getByRole('button', { name: /Export/i });
      expect(exportButton).not.toBeDisabled();
    });

    it.each([{ version: '0.5.0' }, { version: '1.0.0-beta.1' }] as const)(
      'accepts min Devchain version $version',
      ({ version }) => {
        render(<ExportDialog {...defaultProps} />);
        const input = screen.getByLabelText('Min Devchain Version');
        fireEvent.change(input, { target: { value: version } });
        expect(input).toHaveValue(version);
        expect(screen.getByRole('button', { name: /^Export$/i })).not.toBeDisabled();
        expect(screen.queryByText(/Invalid version format/)).not.toBeInTheDocument();
      },
    );
  });
});
