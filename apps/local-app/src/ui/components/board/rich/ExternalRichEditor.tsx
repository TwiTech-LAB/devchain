import { useEffect, useRef } from 'react';
import type { Content } from '@tiptap/react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';

/**
 * Lazy-loaded rich editor for ExternalRichDocumentV1. The editor chunk is
 * only imported when a user explicitly starts an Edit; this component must
 * stay out of any statically imported graph. Starter-kit nodes outside the
 * closed canonical set (ordered lists, code blocks, strike, horizontal
 * rules) are disabled so the editor cannot produce unsupported content, and
 * links stay http(s)-only by backend validation.
 */
export function ExternalRichEditor({
  initialDocument,
  onChange,
  ariaLabel,
}: {
  initialDocument: Content;
  onChange: (document: unknown) => void;
  ariaLabel: string;
}) {
  // The editor is constructed exactly once per Edit; document swaps go
  // through explicit remounts by the parent (keyed by session id).
  const initialJsonRef = useRef<Content>(initialDocument);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          orderedList: false,
          codeBlock: false,
          strike: false,
          horizontalRule: false,
          // The read-only path renders plain code styling; underline and
          // text-style helpers are not part of the closed mark set.
          dropcursor: false,
          gapcursor: false,
        }),
        Link.configure({
          openOnClick: false,
          autolink: false,
          linkOnPaste: true,
          HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
        }),
      ],
      content: initialJsonRef.current,
      editorProps: {
        attributes: {
          'aria-label': ariaLabel,
          role: 'textbox',
          'aria-multiline': 'true',
          class: 'prose prose-sm max-w-none min-h-[8rem] focus:outline-none',
        },
      },
      onUpdate: ({ editor }) => {
        onChangeRef.current(editor.getJSON());
      },
    },
    [],
  );

  useEffect(() => {
    return () => {
      editor?.destroy();
    };
  }, [editor]);

  if (!editor) {
    return (
      <div
        className="min-h-[8rem] animate-pulse rounded-md border bg-muted/30"
        aria-hidden="true"
      />
    );
  }

  return (
    <div
      className="rounded-md border bg-background p-3"
      role="group"
      aria-label="Rich description editor"
    >
      <div className="mb-2 flex flex-wrap gap-1" role="toolbar" aria-label="Formatting">
        <EditorButton
          label="Bold"
          active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          B
        </EditorButton>
        <EditorButton
          label="Italic"
          active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          I
        </EditorButton>
        <EditorButton
          label="Inline code"
          active={editor.isActive('code')}
          onClick={() => editor.chain().focus().toggleCode().run()}
        >
          {'</>'}
        </EditorButton>
        <EditorButton
          label="Bulleted list"
          active={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          •≡
        </EditorButton>
        <EditorButton
          label="Blockquote"
          active={editor.isActive('blockquote')}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          ❝
        </EditorButton>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}

function EditorButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={`h-8 w-8 rounded border text-sm font-medium ${
        active ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted'
      }`}
    >
      {children}
    </button>
  );
}
