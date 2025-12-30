import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useBoardFilters } from '@/ui/hooks/useBoardFilters';

function ShowFilters() {
  const { filters } = useBoardFilters();
  return <pre data-testid="filters">{JSON.stringify(filters)}</pre>;
}

describe('useBoardFilters', () => {
  test('reads known params and ignores unknown', () => {
    const ui = (
      <MemoryRouter initialEntries={[{ pathname: '/board', search: '?p=abc&st=review&foo=1' }]}>
        <Routes>
          <Route path="/board" element={<ShowFilters />} />
        </Routes>
      </MemoryRouter>
    );
    render(ui);
    const pre = screen.getByTestId('filters');
    const parsed = JSON.parse(pre.textContent || '{}');
    expect(parsed).toEqual({ parent: 'abc', status: ['review'] });
  });
});
