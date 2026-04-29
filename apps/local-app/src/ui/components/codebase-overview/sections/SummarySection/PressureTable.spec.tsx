import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DistrictSignals } from '@devchain/codebase-overview';
import { PressureTable } from './PressureTable';

// ---------------------------------------------------------------------------
// Mock useVirtualizer to make row rendering deterministic in JSDOM
// ---------------------------------------------------------------------------

const useVirtualizerMock = jest.fn();

jest.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (...args: unknown[]) => useVirtualizerMock(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSignal(overrides: Partial<DistrictSignals> & { districtId: string }): DistrictSignals {
  return {
    name: overrides.districtId,
    path: `src/${overrides.districtId}`,
    regionId: 'r1',
    regionName: 'src',
    files: 10,
    sourceFileCount: 8,
    supportFileCount: 2,
    hasSourceFiles: true,
    loc: 500,
    churn7d: 2,
    churn30d: 5,
    testCoverageRate: 0.5,
    sourceCoverageMeasured: true,
    complexityAvg: 10.0,
    inboundWeight: 3,
    outboundWeight: 2,
    blastRadius: 1,
    couplingScore: 5,
    ownershipHHI: 0.6,
    ownershipMeasured: true,
    primaryAuthorName: 'Dev',
    primaryAuthorShare: 0.8,
    primaryAuthorRecentlyActive: true,
    fileTypeBreakdown: { kind: 'extension', counts: { ts: 8, json: 2 } },
    ...overrides,
  };
}

function setupVirtualizerMock(count?: number) {
  useVirtualizerMock.mockImplementation(
    (config: { count: number; estimateSize: () => number; getItemKey: (i: number) => string }) => ({
      getTotalSize: () => config.count * config.estimateSize(),
      getVirtualItems: () =>
        Array.from({ length: count ?? config.count }, (_, i) => ({
          index: i,
          key: config.getItemKey(i),
          start: i * config.estimateSize(),
          size: config.estimateSize(),
        })),
      measureElement: () => {},
      scrollToIndex: () => {},
    }),
  );
}

const onSelectDistrict = jest.fn();

function renderTable(signals: DistrictSignals[], selectedId: string | null = null) {
  return render(
    <PressureTable
      signals={signals}
      selectedDistrictId={selectedId}
      onSelectDistrict={onSelectDistrict}
    />,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PressureTable', () => {
  beforeEach(() => {
    onSelectDistrict.mockClear();
    localStorage.clear();
    setupVirtualizerMock();
  });

  // -----------------------------------------------------------------------
  // Columns
  // -----------------------------------------------------------------------

  describe('columns', () => {
    it('renders all 11 column headers', () => {
      const signals = [makeSignal({ districtId: 'alpha' })];
      renderTable(signals);

      const headers = [
        'Name',
        'Files',
        'LOC',
        'Churn 7d',
        'Churn 30d',
        'Coverage %',
        'Complexity',
        'Inbound',
        'Outbound',
        'Blast',
        'HHI %',
      ];
      for (const h of headers) {
        expect(screen.getByText(h)).toBeInTheDocument();
      }
    });

    it('renders correct values in row cells', () => {
      const signal = makeSignal({
        districtId: 'modules',
        name: 'modules',
        files: 42,
        loc: 1234,
        churn7d: 7,
        churn30d: 25,
        testCoverageRate: 0.75,
        complexityAvg: 15.6,
        inboundWeight: 8,
        outboundWeight: 4,
        blastRadius: 3,
        ownershipHHI: 0.82,
      });
      renderTable([signal]);

      expect(screen.getByText('modules')).toBeInTheDocument();
      expect(screen.getByText('42')).toBeInTheDocument();
      expect(screen.getByText('1,234')).toBeInTheDocument();
      expect(screen.getByText('7')).toBeInTheDocument();
      expect(screen.getByText('25')).toBeInTheDocument();
      expect(screen.getByText('75%')).toBeInTheDocument();
      expect(screen.getByText('15.6')).toBeInTheDocument();
      expect(screen.getByText('8')).toBeInTheDocument();
      expect(screen.getByText('4')).toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();
      expect(screen.getByText('82%')).toBeInTheDocument();
    });

    it('renders dash for null coverage and complexity', () => {
      const signal = makeSignal({
        districtId: 'd1',
        testCoverageRate: null,
        complexityAvg: null,
        ownershipHHI: null,
      });
      renderTable([signal]);

      const dashes = screen.getAllByText('—');
      expect(dashes.length).toBe(3);
    });

    it('default sort is name ascending', () => {
      const signals = [
        makeSignal({ districtId: 'charlie', name: 'charlie' }),
        makeSignal({ districtId: 'alpha', name: 'alpha' }),
        makeSignal({ districtId: 'bravo', name: 'bravo' }),
      ];
      renderTable(signals);

      const grid = screen.getByRole('grid');
      const rows = within(grid).getAllByRole('row');
      const dataRows = rows.slice(1);
      expect(dataRows[0]!.textContent).toContain('alpha');
      expect(dataRows[1]!.textContent).toContain('bravo');
      expect(dataRows[2]!.textContent).toContain('charlie');
    });
  });

  // -----------------------------------------------------------------------
  // Sorting
  // -----------------------------------------------------------------------

  describe('sorting', () => {
    it('sorts ascending on first click, descending on second, resets on third', async () => {
      const user = userEvent.setup();
      const signals = [
        makeSignal({ districtId: 'a', name: 'a', files: 10 }),
        makeSignal({ districtId: 'b', name: 'b', files: 30 }),
        makeSignal({ districtId: 'c', name: 'c', files: 20 }),
      ];
      renderTable(signals);

      const filesHeader = screen.getByText('Files');

      // Click 1: sort files ascending
      await user.click(filesHeader);
      let rows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      expect(rows[0]!.textContent).toContain('a');
      expect(rows[2]!.textContent).toContain('b');

      // Click 2: sort files descending
      await user.click(filesHeader);
      rows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      expect(rows[0]!.textContent).toContain('b');

      // Click 3: reset to default (name asc)
      await user.click(filesHeader);
      rows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      expect(rows[0]!.textContent).toContain('a');
      expect(rows[1]!.textContent).toContain('b');
      expect(rows[2]!.textContent).toContain('c');
    });

    it('shows sort indicator on active column', async () => {
      const user = userEvent.setup();
      renderTable([makeSignal({ districtId: 'd1' })]);

      const filesHeader = screen.getByText('Files');
      await user.click(filesHeader);

      const header = filesHeader.closest('[role="columnheader"]')!;
      expect(header.getAttribute('aria-sort')).toBe('ascending');
    });

    it('nulls sort to bottom regardless of direction', async () => {
      const user = userEvent.setup();
      const signals = [
        makeSignal({ districtId: 'has-coverage', name: 'has', testCoverageRate: 0.5 }),
        makeSignal({ districtId: 'no-coverage', name: 'no', testCoverageRate: null }),
        makeSignal({ districtId: 'low-coverage', name: 'low', testCoverageRate: 0.1 }),
      ];
      renderTable(signals);

      const coverageHeader = screen.getByText('Coverage %');

      // Ascending: nulls last
      await user.click(coverageHeader);
      let rows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      expect(rows[0]!.textContent).toContain('low');
      expect(rows[2]!.textContent).toContain('no');

      // Descending: nulls still last
      await user.click(coverageHeader);
      rows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      expect(rows[0]!.textContent).toContain('has');
      expect(rows[2]!.textContent).toContain('no');
    });

    it('header is keyboard-sortable via Enter', async () => {
      const user = userEvent.setup();
      const signals = [
        makeSignal({ districtId: 'a', name: 'a', loc: 100 }),
        makeSignal({ districtId: 'b', name: 'b', loc: 300 }),
      ];
      renderTable(signals);

      const locHeader = screen.getByText('LOC');
      locHeader.closest('[role="columnheader"]')!.focus();
      await user.keyboard('{Enter}');

      const rows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      expect(rows[0]!.textContent).toContain('a');
    });
  });

  // -----------------------------------------------------------------------
  // Filters
  // -----------------------------------------------------------------------

  describe('filters', () => {
    it('text search filters by name after 200ms debounce', async () => {
      jest.useFakeTimers();
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      const signals = [
        makeSignal({ districtId: 'modules', name: 'modules' }),
        makeSignal({ districtId: 'utils', name: 'utils' }),
        makeSignal({ districtId: 'models', name: 'models' }),
      ];
      renderTable(signals);

      const input = screen.getByLabelText('Filter districts by name');
      await user.type(input, 'mod');

      // Before debounce: all rows still visible
      let rows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      expect(rows.length).toBe(3);

      // Flush the 200ms debounce
      act(() => jest.advanceTimersByTime(200));

      // After debounce: filtered
      rows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      const names = rows.map((r) => r.textContent);
      expect(names.some((n) => n?.includes('modules'))).toBe(true);
      expect(names.some((n) => n?.includes('models'))).toBe(true);
      expect(names.some((n) => n?.includes('utils'))).toBe(false);

      jest.useRealTimers();
    });

    it('hide support-only toggle excludes non-source districts', async () => {
      const user = userEvent.setup();
      const signals = [
        makeSignal({ districtId: 'source', name: 'source', hasSourceFiles: true }),
        makeSignal({ districtId: 'config', name: 'config', hasSourceFiles: false }),
      ];
      renderTable(signals);

      // Default: support-only hidden
      let rows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      expect(rows.length).toBe(1);
      expect(rows[0]!.textContent).toContain('source');

      // Toggle off: show all
      await user.click(screen.getByText('Hide support-only'));
      rows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      expect(rows.length).toBe(2);
    });

    it('shows empty state when filters yield zero rows', async () => {
      jest.useFakeTimers();
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      const signals = [makeSignal({ districtId: 'alpha', name: 'alpha' })];
      renderTable(signals);

      const input = screen.getByLabelText('Filter districts by name');
      await user.type(input, 'zzzzz');
      act(() => jest.advanceTimersByTime(200));

      expect(screen.getByText('No districts match')).toBeInTheDocument();
      jest.useRealTimers();
    });
  });

  // -----------------------------------------------------------------------
  // Density
  // -----------------------------------------------------------------------

  describe('density', () => {
    it('changes row height when density toggles', async () => {
      const user = userEvent.setup();
      renderTable([makeSignal({ districtId: 'd1' })]);

      const compactBtn = screen.getByLabelText('Compact density');
      await user.click(compactBtn);

      expect(useVirtualizerMock).toHaveBeenCalled();
      const lastCall = useVirtualizerMock.mock.calls[useVirtualizerMock.mock.calls.length - 1]![0];
      expect(lastCall.estimateSize()).toBe(40);
    });

    it('persists density via localStorage', async () => {
      const user = userEvent.setup();
      renderTable([makeSignal({ districtId: 'd1' })]);

      await user.click(screen.getByLabelText('Compact density'));
      expect(localStorage.getItem('overview.tableDensity')).toBe('compact');
    });
  });

  // -----------------------------------------------------------------------
  // Row interaction
  // -----------------------------------------------------------------------

  describe('row interaction', () => {
    it('click row calls onSelectDistrict', async () => {
      const user = userEvent.setup();
      renderTable([makeSignal({ districtId: 'target', name: 'target' })]);

      const rows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      await user.click(rows[0]!);

      expect(onSelectDistrict).toHaveBeenCalledWith('target');
    });

    it('highlights selected row', () => {
      renderTable([makeSignal({ districtId: 'selected', name: 'selected' })], 'selected');

      const rows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      expect(rows[0]!.getAttribute('aria-selected')).toBe('true');
    });
  });

  // -----------------------------------------------------------------------
  // Empty states
  // -----------------------------------------------------------------------

  describe('empty states', () => {
    it('shows empty state when signals are empty', () => {
      renderTable([]);
      expect(screen.getByText('No districts to show')).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // Virtualization
  // -----------------------------------------------------------------------

  describe('virtualization', () => {
    it('with 1000 signals, only renders a subset of rows', () => {
      setupVirtualizerMock(30);
      const signals = Array.from({ length: 1000 }, (_, i) =>
        makeSignal({ districtId: `d${i}`, name: `district-${i}` }),
      );
      renderTable(signals);

      const grid = screen.getByRole('grid');
      const rows = within(grid).getAllByRole('row').slice(1);
      expect(rows.length).toBe(30);
    });

    it('passes correct config to useVirtualizer', () => {
      const signals = Array.from({ length: 50 }, (_, i) => makeSignal({ districtId: `d${i}` }));
      renderTable(signals);

      expect(useVirtualizerMock).toHaveBeenCalled();
      const config = useVirtualizerMock.mock.calls[useVirtualizerMock.mock.calls.length - 1]![0];
      expect(config.overscan).toBe(8);
    });
  });

  // -----------------------------------------------------------------------
  // Roving tabindex (keyboard reachability)
  // -----------------------------------------------------------------------

  describe('roving tabindex', () => {
    it('first row has tabIndex=0 after initial render', () => {
      const signals = Array.from({ length: 5 }, (_, i) =>
        makeSignal({ districtId: `d${i}`, name: `d${i}` }),
      );
      renderTable(signals);

      const rows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      expect(rows[0]!.getAttribute('tabindex')).toBe('0');
      expect(rows[1]!.getAttribute('tabindex')).toBe('-1');
    });

    it('initial render does not move DOM focus into a row', () => {
      const signals = Array.from({ length: 5 }, (_, i) =>
        makeSignal({ districtId: `d${i}`, name: `d${i}` }),
      );
      renderTable(signals);

      const rows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      expect(rows.some((r) => r === document.activeElement)).toBe(false);
    });

    it('ArrowDown moves focus to next row', async () => {
      const user = userEvent.setup();
      const signals = Array.from({ length: 5 }, (_, i) =>
        makeSignal({ districtId: `d${i}`, name: `d${i}` }),
      );
      renderTable(signals);

      const rows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      rows[0]!.focus();
      await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');

      const updatedRows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      expect(updatedRows[3]!.getAttribute('tabindex')).toBe('0');
    });

    it('ArrowUp from first row stays at first row', async () => {
      const user = userEvent.setup();
      const signals = Array.from({ length: 3 }, (_, i) =>
        makeSignal({ districtId: `d${i}`, name: `d${i}` }),
      );
      renderTable(signals);

      const rows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      rows[0]!.focus();
      await user.keyboard('{ArrowUp}');

      const updatedRows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      expect(updatedRows[0]!.getAttribute('tabindex')).toBe('0');
    });

    it('End jumps to last row; Home jumps to first', async () => {
      const user = userEvent.setup();
      const signals = Array.from({ length: 5 }, (_, i) =>
        makeSignal({ districtId: `d${i}`, name: `d${i}` }),
      );
      renderTable(signals);

      const rows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      rows[0]!.focus();
      await user.keyboard('{End}');

      let updatedRows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      expect(updatedRows[4]!.getAttribute('tabindex')).toBe('0');

      updatedRows[4]!.focus();
      await user.keyboard('{Home}');

      updatedRows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      expect(updatedRows[0]!.getAttribute('tabindex')).toBe('0');
    });

    it('Enter on focused row selects the district', async () => {
      const user = userEvent.setup();
      const signals = [makeSignal({ districtId: 'target', name: 'target' })];
      renderTable(signals);

      const rows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      rows[0]!.focus();
      await user.keyboard('{Enter}');

      expect(onSelectDistrict).toHaveBeenCalledWith('target');
    });

    it('filter that removes focused row clamps index to valid range', async () => {
      jest.useFakeTimers();
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      const signals = Array.from({ length: 5 }, (_, i) =>
        makeSignal({ districtId: `d${i}`, name: `district-${i}` }),
      );
      renderTable(signals);

      // Focus last row (index 4)
      const rows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      await user.click(rows[4]!);

      // Filter to only 2 results
      const input = screen.getByLabelText('Filter districts by name');
      await user.type(input, 'district-0');
      act(() => jest.advanceTimersByTime(200));

      // Focus should clamp to valid index
      const updatedRows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      const focusedRow = updatedRows.find((r) => r.getAttribute('tabindex') === '0');
      expect(focusedRow).toBeTruthy();

      jest.useRealTimers();
    });

    it('empty filter result resets focusedRowIndex', async () => {
      jest.useFakeTimers();
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      const signals = [makeSignal({ districtId: 'd1', name: 'alpha' })];
      renderTable(signals);

      const input = screen.getByLabelText('Filter districts by name');
      await user.type(input, 'zzzzz');
      act(() => jest.advanceTimersByTime(200));

      expect(screen.getByText('No districts match')).toBeInTheDocument();

      jest.useRealTimers();
    });

    it('typing in search input does not move focus to a row', async () => {
      jest.useFakeTimers();
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      const signals = Array.from({ length: 3 }, (_, i) =>
        makeSignal({ districtId: `d${i}`, name: `d${i}` }),
      );
      renderTable(signals);

      const input = screen.getByLabelText('Filter districts by name');
      await user.click(input);
      await user.type(input, 'test');
      act(() => jest.advanceTimersByTime(200));

      expect(document.activeElement).toBe(input);

      jest.useRealTimers();
    });

    it('applying region filter does not move focus', async () => {
      const user = userEvent.setup();
      const signals = [
        makeSignal({ districtId: 'd0', name: 'd0', regionName: 'src' }),
        makeSignal({ districtId: 'd1', name: 'd1', regionName: 'lib' }),
      ];
      renderTable(signals);

      const select = screen.getByLabelText('Filter by region');
      await user.selectOptions(select, ['src']);

      const rows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      expect(rows.some((r) => r === document.activeElement)).toBe(false);
    });

    it('sort change does not steal focus from filter input', async () => {
      const user = userEvent.setup();
      const signals = Array.from({ length: 3 }, (_, i) =>
        makeSignal({ districtId: `d${i}`, name: `d${i}`, files: (i + 1) * 10 }),
      );
      renderTable(signals);

      const input = screen.getByLabelText('Filter districts by name');
      await user.click(input);

      const filesHeader = screen.getByText('Files');
      await user.click(filesHeader);

      const rows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      expect(rows.some((r) => r === document.activeElement)).toBe(false);
    });

    it('ArrowDown after typing moves focus to a row', async () => {
      const user = userEvent.setup();
      const signals = Array.from({ length: 3 }, (_, i) =>
        makeSignal({ districtId: `d${i}`, name: `d${i}` }),
      );
      renderTable(signals);

      const rows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      rows[0]!.focus();
      await user.keyboard('{ArrowDown}');

      const updatedRows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      expect(updatedRows[1]!.getAttribute('tabindex')).toBe('0');
      expect(document.activeElement).toBe(updatedRows[1]!);
    });

    it('mouse click updates focused index and subsequent ArrowDown continues from there', async () => {
      const user = userEvent.setup();
      const signals = Array.from({ length: 5 }, (_, i) =>
        makeSignal({ districtId: `d${i}`, name: `d${i}` }),
      );
      renderTable(signals);

      const rows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      await user.click(rows[2]!);

      let updatedRows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      expect(updatedRows[2]!.getAttribute('tabindex')).toBe('0');

      await user.keyboard('{ArrowDown}');
      updatedRows = within(screen.getByRole('grid')).getAllByRole('row').slice(1);
      expect(updatedRows[3]!.getAttribute('tabindex')).toBe('0');
      expect(document.activeElement).toBe(updatedRows[3]!);
    });
  });

  // -----------------------------------------------------------------------
  // Touch targets ≥ 40px
  // -----------------------------------------------------------------------

  describe('touch targets', () => {
    it('search input has h-10 class', () => {
      renderTable([makeSignal({ districtId: 'd1' })]);
      const input = screen.getByLabelText('Filter districts by name');
      expect(input.className).toContain('h-10');
    });

    it('region select has h-10 class', () => {
      renderTable([makeSignal({ districtId: 'd1' })]);
      const select = screen.getByLabelText('Filter by region');
      expect(select.className).toContain('h-10');
    });

    it('support-only button has h-10 class', () => {
      renderTable([makeSignal({ districtId: 'd1' })]);
      const btn = screen.getByText('Hide support-only');
      expect(btn.className).toContain('h-10');
    });

    it('compact row height is at least 40px', () => {
      renderTable([makeSignal({ districtId: 'd1' })]);
      const config = useVirtualizerMock.mock.calls[useVirtualizerMock.mock.calls.length - 1]![0];
      expect(config.estimateSize()).toBeGreaterThanOrEqual(40);
    });
  });
});
