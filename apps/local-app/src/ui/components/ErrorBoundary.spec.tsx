import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { RouteErrorBoundary } from './ErrorBoundary';

let shouldThrow = true;

function Faulty() {
  if (shouldThrow) throw new Error('board data is malformed');
  return <p>Board</p>;
}

function GoToSettings() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/settings')}>Settings link</button>;
}

describe('RouteErrorBoundary', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    shouldThrow = true;
    // React and the boundary both report the caught error.
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('shows a fallback for a page that throws, retries it, and clears on another route', () => {
    render(
      <MemoryRouter initialEntries={['/board']}>
        <GoToSettings />
        <RouteErrorBoundary>
          <Routes>
            <Route path="/board" element={<Faulty />} />
            <Route path="/settings" element={<p>Settings</p>} />
          </Routes>
        </RouteErrorBoundary>
      </MemoryRouter>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('board data is malformed');
    // The frame outside the boundary stays usable.
    expect(screen.getByRole('button', { name: 'Settings link' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Board')).toBeInTheDocument();

    shouldThrow = true;
    fireEvent.click(screen.getByRole('button', { name: 'Settings link' }));
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
