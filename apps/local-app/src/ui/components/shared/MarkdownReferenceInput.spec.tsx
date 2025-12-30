import React, { useState } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MarkdownReferenceInput } from './MarkdownReferenceInput';

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function ReferenceInputHarness() {
  const [value, setValue] = useState('');
  return (
    <MarkdownReferenceInput value={value} onChange={setValue} placeholder="Write instructions..." />
  );
}

describe('MarkdownReferenceInput', () => {
  const originalFetch = globalThis.fetch;
  let fetchSpy: jest.SpyInstance;
  let rafSpy: jest.SpyInstance;

  beforeEach(() => {
    if (!globalThis.fetch) {
      globalThis.fetch = jest.fn();
    }
    fetchSpy = jest.spyOn(globalThis, 'fetch');
    rafSpy = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(performance.now());
        return 1;
      });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as unknown as { fetch?: unknown }).fetch;
    }
    rafSpy.mockRestore();
  });

  it('suggests grouped tag references and inserts [[#key]] when selected', async () => {
    fetchSpy.mockImplementation((input: RequestInfo) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('tagKey=role')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'doc-1',
                title: 'Role Playbook',
                slug: 'role-playbook',
                tags: ['role:worker'],
                projectId: null,
              },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) } as Response);
    });

    renderWithQuery(<ReferenceInputHarness />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.focus(textarea);
    fireEvent.input(textarea, { target: { value: '#role' } });
    textarea.setSelectionRange('#role'.length, '#role'.length);
    fireEvent.keyUp(textarea, { key: 'e' });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    const allOption = await screen.findByRole('option', { name: /All role:\*/i });
    expect(allOption).toBeInTheDocument();
    const docOption = screen.getByRole('option', { name: /Role Playbook/i });
    expect(docOption).toBeInTheDocument();

    fireEvent.mouseDown(allOption);

    await waitFor(() => expect(textarea).toHaveValue('[[#role]]'));
  });

  it('suggests documents for @ search tokens and inserts slug references', async () => {
    fetchSpy.mockImplementation((input: RequestInfo) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/documents') && url.includes('q=read')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'doc-2',
                title: 'Readme',
                slug: 'readme',
                tags: ['guide'],
                projectId: null,
              },
            ],
          }),
        } as Response);
      }
      // Return empty for prompts (no projectId)
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) } as Response);
    });

    renderWithQuery(<ReferenceInputHarness />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.focus(textarea);
    fireEvent.input(textarea, { target: { value: '@read' } });
    textarea.setSelectionRange('@read'.length, '@read'.length);
    fireEvent.keyUp(textarea, { key: 'd' });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    const docOption = await screen.findByRole('option', { name: /Readme/i });
    fireEvent.mouseDown(docOption);

    await waitFor(() => expect(textarea).toHaveValue('[[readme]]'));
  });

  it('suggests prompts for @ search and inserts [[prompt:title]] references', async () => {
    fetchSpy.mockImplementation((input: RequestInfo) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/documents') && url.includes('q=init')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ items: [] }),
        } as Response);
      }
      if (url.includes('/api/prompts') && url.includes('q=init')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'prompt-1',
                title: 'Initialize Agent',
                tags: ['setup'],
                projectId: 'project-1',
              },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) } as Response);
    });

    function HarnessWithProject() {
      const [value, setValue] = useState('');
      return (
        <MarkdownReferenceInput
          value={value}
          onChange={setValue}
          projectId="project-1"
          placeholder="Write instructions..."
        />
      );
    }

    renderWithQuery(<HarnessWithProject />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.focus(textarea);
    fireEvent.input(textarea, { target: { value: '@init' } });
    textarea.setSelectionRange('@init'.length, '@init'.length);
    fireEvent.keyUp(textarea, { key: 't' });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    const promptOption = await screen.findByRole('option', { name: /Initialize Agent/i });
    expect(promptOption).toBeInTheDocument();

    fireEvent.mouseDown(promptOption);

    await waitFor(() => expect(textarea).toHaveValue('[[prompt:Initialize Agent]]'));
  });
});
