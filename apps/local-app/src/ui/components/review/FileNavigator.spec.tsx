import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileNavigator, type FileNavigatorProps } from './FileNavigator';
import type { ChangedFile } from '@/ui/lib/reviews';

// Mock ResizeObserver for ScrollArea component
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock layout properties for virtualizer (jsdom doesn't support layout)
// The virtualizer needs proper dimensions to calculate which items to render
// Save original descriptors for restoration in afterAll to prevent cross-suite pollution
const originalOffsetHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'offsetHeight',
);
const originalOffsetWidthDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'offsetWidth',
);

Object.defineProperties(HTMLElement.prototype, {
  offsetHeight: {
    configurable: true,
    get() {
      // Return mock height for virtualizer scroll container
      if (this.getAttribute('role') === 'listbox') return 400;
      return 0;
    },
  },
  offsetWidth: {
    configurable: true,
    get() {
      if (this.getAttribute('role') === 'listbox') return 300;
      return 0;
    },
  },
});

afterAll(() => {
  // Restore original HTMLElement.prototype properties to prevent test pollution
  if (originalOffsetHeightDescriptor) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeightDescriptor);
  } else {
    delete (HTMLElement.prototype as Record<string, unknown>).offsetHeight;
  }
  if (originalOffsetWidthDescriptor) {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidthDescriptor);
  } else {
    delete (HTMLElement.prototype as Record<string, unknown>).offsetWidth;
  }
});

const mockFiles: ChangedFile[] = [
  { path: 'src/auth/login.ts', status: 'modified', additions: 10, deletions: 5 },
  { path: 'src/auth/logout.ts', status: 'added', additions: 20, deletions: 0 },
  { path: 'src/utils/helpers.ts', status: 'modified', additions: 5, deletions: 2 },
  { path: 'src/old-file.ts', status: 'deleted', additions: 0, deletions: 15 },
  { path: 'README.md', status: 'modified', additions: 3, deletions: 1 },
];

const defaultProps: FileNavigatorProps = {
  files: mockFiles,
  selectedFile: null,
  onSelectFile: jest.fn(),
};

function renderFileNavigator(props: Partial<FileNavigatorProps> = {}) {
  return render(<FileNavigator {...defaultProps} {...props} />);
}

describe('FileNavigator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders file list with all files', () => {
    renderFileNavigator();

    expect(screen.getByText('login.ts')).toBeInTheDocument();
    expect(screen.getByText('logout.ts')).toBeInTheDocument();
    expect(screen.getByText('helpers.ts')).toBeInTheDocument();
    expect(screen.getByText('old-file.ts')).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();
  });

  it('renders folder structure in tree view', () => {
    renderFileNavigator();

    // Should show folder names
    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByText('auth')).toBeInTheDocument();
    expect(screen.getByText('utils')).toBeInTheDocument();
  });

  it('shows status indicators for files via icon color and sr-only text', () => {
    renderFileNavigator();

    // Check for sr-only status text (screen reader accessible)
    const addedStatuses = screen.getAllByText('added');
    const modifiedStatuses = screen.getAllByText('modified');
    const deletedStatuses = screen.getAllByText('deleted');

    expect(addedStatuses.length).toBe(1); // logout.ts
    expect(modifiedStatuses.length).toBe(3); // login.ts, helpers.ts, README.md
    expect(deletedStatuses.length).toBe(1); // old-file.ts
  });

  it('shows line changes for files', () => {
    renderFileNavigator();

    // Check for additions/deletions display
    expect(screen.getByText('+10')).toBeInTheDocument();
    expect(screen.getByText('-5')).toBeInTheDocument();
    expect(screen.getByText('+20')).toBeInTheDocument();
  });

  it('highlights selected file', async () => {
    renderFileNavigator({ selectedFile: 'src/auth/login.ts' });

    const loginButton = screen.getByText('login.ts').closest('button');
    expect(loginButton).toHaveClass('bg-accent');
  });

  it('calls onSelectFile when file is clicked', async () => {
    const onSelectFile = jest.fn();
    renderFileNavigator({ onSelectFile });

    await userEvent.click(screen.getByText('login.ts'));

    expect(onSelectFile).toHaveBeenCalledWith('src/auth/login.ts');
  });

  it('collapses and expands folders', async () => {
    renderFileNavigator();

    // Initially folders are expanded, files should be visible
    expect(screen.getByText('login.ts')).toBeInTheDocument();

    // Click on 'auth' folder to collapse
    await userEvent.click(screen.getByText('auth'));

    // Files inside auth should be hidden
    expect(screen.queryByText('login.ts')).not.toBeInTheDocument();
    expect(screen.queryByText('logout.ts')).not.toBeInTheDocument();

    // Click again to expand
    await userEvent.click(screen.getByText('auth'));

    // Files should be visible again
    expect(screen.getByText('login.ts')).toBeInTheDocument();
    expect(screen.getByText('logout.ts')).toBeInTheDocument();
  });

  it('filters files by search query', async () => {
    renderFileNavigator();

    const searchInput = screen.getByPlaceholderText('Filter files...');
    await userEvent.type(searchInput, 'login');

    expect(screen.getByText('login.ts')).toBeInTheDocument();
    expect(screen.queryByText('logout.ts')).not.toBeInTheDocument();
    expect(screen.queryByText('helpers.ts')).not.toBeInTheDocument();
  });

  it('shows no results message when search has no matches', async () => {
    renderFileNavigator();

    const searchInput = screen.getByPlaceholderText('Filter files...');
    await userEvent.type(searchInput, 'nonexistent');

    expect(screen.getByText('No files match "nonexistent"')).toBeInTheDocument();
  });

  it('shows comment count badges when provided', () => {
    const commentCounts = {
      'src/auth/login.ts': 3,
      'src/utils/helpers.ts': 1,
    };
    renderFileNavigator({ commentCounts });

    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('switches between tree and flat view modes', async () => {
    renderFileNavigator();

    // Tree view by default
    expect(screen.getByText('src')).toBeInTheDocument();

    // Switch to flat view
    await userEvent.click(screen.getByText('Flat'));

    // Should show full paths in flat view
    expect(screen.getByText('src/auth/login.ts')).toBeInTheDocument();
    expect(screen.queryByText('src')).not.toBeInTheDocument();
  });

  it('shows file count summary in footer', () => {
    renderFileNavigator();

    expect(screen.getByText('5 files changed')).toBeInTheDocument();
  });

  it('shows filtered count when searching', async () => {
    renderFileNavigator();

    const searchInput = screen.getByPlaceholderText('Filter files...');
    await userEvent.type(searchInput, 'auth');

    expect(screen.getByText(/2 shown/)).toBeInTheDocument();
  });

  it('shows empty state when no files', () => {
    renderFileNavigator({ files: [] });

    expect(screen.getByText('No files changed')).toBeInTheDocument();
  });

  it('shows loading state when isLoading is true', () => {
    renderFileNavigator({ isLoading: true });

    // Should show skeleton elements
    const skeletons = document.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('expands all folders when clicking Expand button', async () => {
    renderFileNavigator();

    // Collapse auth folder first
    await userEvent.click(screen.getByText('auth'));
    expect(screen.queryByText('login.ts')).not.toBeInTheDocument();

    // Click Expand
    await userEvent.click(screen.getByText('Expand'));

    // Files should be visible again
    expect(screen.getByText('login.ts')).toBeInTheDocument();
  });

  it('collapses all folders when clicking Collapse button', async () => {
    renderFileNavigator();

    // All files should be visible initially
    expect(screen.getByText('login.ts')).toBeInTheDocument();

    // Click Collapse
    await userEvent.click(screen.getByText('Collapse'));

    // Files inside folders should be hidden (only root-level file visible)
    expect(screen.queryByText('login.ts')).not.toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument(); // Root level file
  });

  it('handles renamed file status', () => {
    const filesWithRename: ChangedFile[] = [
      {
        path: 'src/new-name.ts',
        status: 'renamed',
        additions: 0,
        deletions: 0,
        oldPath: 'src/old-name.ts',
      },
    ];
    renderFileNavigator({ files: filesWithRename });

    expect(screen.getByText('renamed')).toBeInTheDocument();
  });

  it('handles copied file status', () => {
    const filesWithCopy: ChangedFile[] = [
      { path: 'src/copy.ts', status: 'copied', additions: 5, deletions: 0 },
    ];
    renderFileNavigator({ files: filesWithCopy });

    expect(screen.getByText('copied')).toBeInTheDocument();
  });
});
