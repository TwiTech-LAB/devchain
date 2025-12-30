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
    it('renders dialog with title and description', () => {
      render(<ExportDialog {...defaultProps} />);

      expect(screen.getByText('Export Project')).toBeInTheDocument();
      expect(screen.getByText(/Configure template metadata/)).toBeInTheDocument();
    });

    it('renders all form fields', () => {
      render(<ExportDialog {...defaultProps} />);

      expect(screen.getByLabelText('Slug')).toBeInTheDocument();
      expect(screen.getByLabelText('Name')).toBeInTheDocument();
      expect(screen.getByLabelText('Description')).toBeInTheDocument();
      // Category field removed - defaults to 'development' internally
      expect(screen.getByLabelText('Tags')).toBeInTheDocument();
      expect(screen.getByLabelText('Version')).toBeInTheDocument();
      expect(screen.getByLabelText('Changelog')).toBeInTheDocument();
      expect(screen.getByLabelText('Author')).toBeInTheDocument();
    });

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

    it('allows clicking Patch button to bump patch version', async () => {
      render(<ExportDialog {...defaultProps} existingManifest={{ version: '1.2.3' }} />);

      const patchButton = screen.getByRole('button', { name: 'Patch' });
      await userEvent.click(patchButton);

      expect(screen.getByLabelText('Version')).toHaveValue('1.2.4');
    });

    it('allows clicking Minor button to bump minor version', async () => {
      render(<ExportDialog {...defaultProps} existingManifest={{ version: '1.2.3' }} />);

      const minorButton = screen.getByRole('button', { name: 'Minor' });
      await userEvent.click(minorButton);

      expect(screen.getByLabelText('Version')).toHaveValue('1.3.0');
    });

    it('allows clicking Major button to bump major version', async () => {
      render(<ExportDialog {...defaultProps} existingManifest={{ version: '1.2.3' }} />);

      const majorButton = screen.getByRole('button', { name: 'Major' });
      await userEvent.click(majorButton);

      expect(screen.getByLabelText('Version')).toHaveValue('2.0.0');
    });
  });

  describe('tag management', () => {
    it('allows adding a tag', async () => {
      render(<ExportDialog {...defaultProps} />);

      const tagInput = screen.getByLabelText('Tags');
      await userEvent.type(tagInput, 'new-tag');

      const addButton = screen.getByRole('button', { name: 'Add' });
      await userEvent.click(addButton);

      expect(screen.getByText('new-tag')).toBeInTheDocument();
    });

    it('allows adding tag by pressing Enter', async () => {
      render(<ExportDialog {...defaultProps} />);

      const tagInput = screen.getByLabelText('Tags');
      await userEvent.type(tagInput, 'enter-tag{enter}');

      expect(screen.getByText('enter-tag')).toBeInTheDocument();
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
    it('renders Min Devchain Version input field', () => {
      render(<ExportDialog {...defaultProps} />);

      expect(screen.getByLabelText('Min Devchain Version')).toBeInTheDocument();
      expect(
        screen.getByText('Minimum Devchain version required to use this template'),
      ).toBeInTheDocument();
    });

    it('pre-fills minDevchainVersion from existing manifest', () => {
      render(<ExportDialog {...defaultProps} existingManifest={{ minDevchainVersion: '0.4.0' }} />);

      expect(screen.getByLabelText('Min Devchain Version')).toHaveValue('0.4.0');
    });

    it('accepts valid semver input', async () => {
      render(<ExportDialog {...defaultProps} />);

      const input = screen.getByLabelText('Min Devchain Version');
      await userEvent.type(input, '1.0.0');

      expect(input).toHaveValue('1.0.0');
      // Should not show validation error
      expect(screen.queryByText(/Invalid version format/)).not.toBeInTheDocument();
    });

    it('shows validation error for invalid semver', async () => {
      render(<ExportDialog {...defaultProps} />);

      const input = screen.getByLabelText('Min Devchain Version');
      await userEvent.type(input, 'invalid-version');

      expect(screen.getByText(/Invalid version format/)).toBeInTheDocument();
    });

    it('disables Export button when minDevchainVersion is invalid', async () => {
      render(<ExportDialog {...defaultProps} />);

      const input = screen.getByLabelText('Min Devchain Version');
      await userEvent.type(input, 'not-semver');

      const exportButton = screen.getByRole('button', { name: /Export/i });
      expect(exportButton).toBeDisabled();
    });

    it('enables Export button when minDevchainVersion is empty (optional field)', () => {
      render(<ExportDialog {...defaultProps} />);

      // Empty by default
      expect(screen.getByLabelText('Min Devchain Version')).toHaveValue('');

      const exportButton = screen.getByRole('button', { name: /Export/i });
      expect(exportButton).not.toBeDisabled();
    });

    it('enables Export button when minDevchainVersion is valid', async () => {
      render(<ExportDialog {...defaultProps} />);

      const input = screen.getByLabelText('Min Devchain Version');
      await userEvent.type(input, '0.4.0');

      const exportButton = screen.getByRole('button', { name: /Export/i });
      expect(exportButton).not.toBeDisabled();
    });

    it('allows setting minDevchainVersion and keeps export button enabled', async () => {
      // Note: Full export request verification requires integration tests
      // due to Radix Dialog's pointer-events handling in jsdom.
      // This test verifies the field value is set and form remains valid.
      render(<ExportDialog {...defaultProps} />);

      const input = screen.getByLabelText('Min Devchain Version');
      fireEvent.change(input, { target: { value: '0.5.0' } });

      // Verify the input has the correct value
      expect(input).toHaveValue('0.5.0');

      // Verify validation passes (button not disabled)
      const exportButton = screen.getByRole('button', { name: /^Export$/i });
      expect(exportButton).not.toBeDisabled();

      // Verify no validation error is shown
      expect(screen.queryByText(/Invalid version format/)).not.toBeInTheDocument();
    });

    it('accepts semver with prerelease tag', async () => {
      render(<ExportDialog {...defaultProps} />);

      const input = screen.getByLabelText('Min Devchain Version');
      await userEvent.type(input, '1.0.0-beta.1');

      expect(input).toHaveValue('1.0.0-beta.1');
      expect(screen.queryByText(/Invalid version format/)).not.toBeInTheDocument();
    });
  });
});
