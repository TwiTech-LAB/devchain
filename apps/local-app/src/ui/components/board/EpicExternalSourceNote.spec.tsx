import { fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ExternalTaskSourceSummary } from '@/modules/external-integrations/models/external-provider.models';
import { EpicExternalSourceNote } from './EpicExternalSourceNote';

function source(overrides: Partial<ExternalTaskSourceSummary> = {}): ExternalTaskSourceSummary {
  return {
    provider: 'jira',
    remoteTaskId: 'ENG-1',
    remoteKey: 'ENG-1',
    title: 'Remote title',
    workAreaName: 'Delivery',
    statusName: 'In Progress',
    webUrl: 'https://acme.atlassian.net/browse/ENG-1',
    linkedAt: '2026-08-19T10:00:00.000Z',
    ...overrides,
  };
}

function LinkedRouteProbe() {
  const { pathname, search, state } = useLocation();
  const returnState = (state as { boardReturnUrl?: string } | null)?.boardReturnUrl;
  return (
    <p data-testid="linked-probe">
      {`${pathname}${search}`}|{returnState ?? '<none>'}
    </p>
  );
}

function renderNote(
  noteSource: ExternalTaskSourceSummary = source(),
  { initialEntry = '/board?st=s1&v=list&pg=2' }: { initialEntry?: string } = {},
) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          path="/board"
          element={
            <main>
              <EpicExternalSourceNote source={noteSource} epicId="epic-1" />
            </main>
          }
        />
        <Route path="/board/:provider/linked/:epicId" element={<LinkedRouteProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('EpicExternalSourceNote', () => {
  it('renders the provider, remote key, and the internal linked-task link', async () => {
    const { baseElement } = renderNote();

    expect(screen.getByText('Imported from Jira ·', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('ENG-1', { selector: 'span.font-medium' })).toBeInTheDocument();
    const anchor = screen.getByRole('link', { name: 'Open linked task ENG-1 in DevChain' });
    expect(anchor).toHaveAttribute('href', '/board/jira/linked/epic-1');
    expect(anchor).not.toHaveAttribute('target');
    expect(anchor).not.toHaveAttribute('rel');
    expect(anchor).toHaveAttribute('draggable', 'false');
    expect(await axe(baseElement)).toHaveNoViolations();
  });

  it('derives the link from the durable Epic, never from the stored vendor URL', () => {
    renderNote(source({ webUrl: 'https://evil.example/ENG-1' }));

    const anchor = screen.getByRole('link', { name: 'Open linked task ENG-1 in DevChain' });
    expect(anchor).toHaveAttribute('href', '/board/jira/linked/epic-1');
    expect(anchor.getAttribute('href')).not.toContain('evil.example');
  });

  it('carries the exact native Board pathname and query as return state', () => {
    renderNote();

    fireEvent.click(screen.getByRole('link', { name: 'Open linked task ENG-1 in DevChain' }));

    expect(screen.getByTestId('linked-probe')).toHaveTextContent(
      '/board/jira/linked/epic-1|/board?st=s1&v=list&pg=2',
    );
  });

  it('stops click and key propagation from the link', () => {
    const onClick = jest.fn();
    const onKeyDown = jest.fn();
    render(
      <MemoryRouter>
        <div onClick={onClick} onKeyDown={onKeyDown}>
          <EpicExternalSourceNote source={source()} epicId="epic-1" />
        </div>
      </MemoryRouter>,
    );
    const anchor = screen.getByRole('link');

    fireEvent.click(anchor);
    expect(onClick).not.toHaveBeenCalled();

    fireEvent.keyDown(anchor, { key: 'Enter' });
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it('cancels drag start on the link', () => {
    const onDragStart = jest.fn();
    render(
      <MemoryRouter>
        <div onDragStart={onDragStart}>
          <EpicExternalSourceNote source={source()} epicId="epic-1" />
        </div>
      </MemoryRouter>,
    );
    const anchor = screen.getByRole('link');
    const dragEvent = fireEvent.dragStart(anchor);

    expect(dragEvent).toBe(false);
    expect(onDragStart).not.toHaveBeenCalled();
  });
});
