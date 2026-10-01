/** The server's refusal of a start request, shown as sent; the form stays open to retry. */
export function StartError({ error }: { error?: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="break-words text-sm text-destructive">
      {error}
    </p>
  );
}
