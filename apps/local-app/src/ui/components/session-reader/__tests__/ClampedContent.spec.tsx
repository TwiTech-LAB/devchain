import { fireEvent, render, screen } from '@testing-library/react';
import { ClampedContent } from '../ClampedContent';
import { TranscriptDisclosureProvider } from '@/ui/hooks/useTranscriptDisclosure';
import { installLayoutMock, rect, type LayoutMock } from './layout-mock';

const CAP = 100;

let layout: LayoutMock;

beforeEach(() => {
  layout = installLayoutMock();
});

afterEach(() => {
  layout.restore();
  jest.restoreAllMocks();
});

function Content({ height, withLink = false }: { height: number; withLink?: boolean }) {
  return (
    <div data-height={height}>
      text
      {withLink && <a href="https://example.com">below the clip</a>}
    </div>
  );
}

const toggle = () => screen.queryByRole('button', { name: /show (full|less)/i });

describe('ClampedContent', () => {
  it('clips long content without a scroller and expands in place', () => {
    render(
      <ClampedContent disclosureKey="k" maxHeight={CAP}>
        <Content height={300} />
      </ClampedContent>,
    );

    const button = screen.getByRole('button', { name: 'Show full' });
    const clip = document.getElementById(button.getAttribute('aria-controls')!)!;
    expect(clip).toHaveClass('overflow-y-clip');
    expect(clip.className).not.toMatch(/overflow-y-(auto|hidden)/);
    expect(clip.style.maxHeight).toBe(`${CAP}px`);
    // The measured wrapper contains its children's margins and never scrolls itself.
    const inner = clip.firstElementChild as HTMLElement;
    expect(inner).toHaveClass('flow-root');
    expect(inner.className).not.toMatch(/overflow/);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('clamped-content-fade')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(button);

    expect(clip.style.maxHeight).toBe('');
    expect(screen.queryByTestId('clamped-content-fade')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it.each([
    { name: 'short content', height: 50, truncated: false, expected: null },
    { name: 'content exactly at the cap', height: CAP, truncated: false, expected: null },
    {
      name: 'content just above the cap',
      height: CAP + 0.5,
      truncated: false,
      expected: 'Show full',
    },
    { name: 'truncated content that fits', height: 50, truncated: true, expected: 'Show full' },
  ])('$name → toggle $expected', ({ height, truncated, expected }) => {
    render(
      <ClampedContent disclosureKey="k" maxHeight={CAP} truncated={truncated}>
        <Content height={height} />
      </ClampedContent>,
    );
    expect(toggle()?.textContent ?? null).toBe(expected);
  });

  it('rechecks on resize and keeps "Show less" while expanded', () => {
    const { container } = render(
      <ClampedContent disclosureKey="k" maxHeight={CAP}>
        <Content height={50} />
      </ClampedContent>,
    );
    expect(toggle()).toBeNull();

    (container.querySelector('[data-height]') as HTMLElement).dataset.height = '300';
    layout.resizeAll();
    fireEvent.click(screen.getByRole('button', { name: 'Show full' }));

    layout.resizeAll();
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
  });

  it('expands when focus moves to a link below the clip', () => {
    const onExpandedChange = jest.fn();
    render(
      <ClampedContent disclosureKey="k" maxHeight={CAP} onExpandedChange={onExpandedChange}>
        <Content height={300} withLink />
      </ClampedContent>,
    );
    const link = screen.getByRole('link');
    layout.rects.set(link, rect(250, 20));
    const clip = document.getElementById(
      screen.getByRole('button').getAttribute('aria-controls')!,
    )!;
    layout.rects.set(clip, rect(0, CAP));

    fireEvent.focus(link);

    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
    expect(onExpandedChange).toHaveBeenCalledWith(true);
  });

  it('on "Show less" scrolls only the transcript container to the block top', () => {
    render(
      <div data-transcript-scroll-container="" data-testid="scroller">
        <ClampedContent disclosureKey="k" maxHeight={CAP} data-testid="block">
          <Content height={300} />
        </ClampedContent>
      </div>,
    );
    const scroller = screen.getByTestId('scroller');
    scroller.scrollTop = 500;
    layout.rects.set(scroller, rect(0, 400));
    layout.rects.set(screen.getByTestId('block'), rect(-200, 300));
    const scrollTo = jest.spyOn(window, 'scrollTo').mockImplementation(() => {});

    fireEvent.click(screen.getByRole('button', { name: 'Show full' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));

    expect(scroller.scrollTop).toBe(300);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('keeps the open state across unmount and remount inside the provider', () => {
    const block = (
      <ClampedContent disclosureKey="chunk-1:user:m1" maxHeight={CAP}>
        <Content height={300} />
      </ClampedContent>
    );
    const { rerender } = render(
      <TranscriptDisclosureProvider scope="s">{block}</TranscriptDisclosureProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show full' }));

    rerender(<TranscriptDisclosureProvider scope="s">{null}</TranscriptDisclosureProvider>);
    rerender(<TranscriptDisclosureProvider scope="s">{block}</TranscriptDisclosureProvider>);

    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
  });

  it('in controlled mode follows `expanded` and reports toggles', () => {
    const onExpandedChange = jest.fn();
    const { rerender } = render(
      <ClampedContent
        disclosureKey="k"
        expanded={false}
        onExpandedChange={onExpandedChange}
        maxHeight={CAP}
      >
        <Content height={300} />
      </ClampedContent>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show full' }));
    expect(onExpandedChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole('button', { name: 'Show full' })).toBeInTheDocument();

    rerender(
      <ClampedContent
        disclosureKey="k"
        expanded
        onExpandedChange={onExpandedChange}
        maxHeight={CAP}
      >
        <Content height={300} />
      </ClampedContent>,
    );
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
  });
});
