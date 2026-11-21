import type { SaveStatus } from "./use-saver.ts";

const text = (status: SaveStatus): string => {
  switch (status.kind) {
    case "idle":
      return "";
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved.";
    case "failed":
      // The words "Not saved" carry the failure; the style only reinforces it.
      return `Not saved: ${status.message} What you typed is still here.`;
  }
};

interface SaveStatusLineProps {
  id: string;
  status: SaveStatus;
}

/**
 * The outcome of the last write, as text beside the controls it belongs to.
 * The element is always rendered, empty at first, because a live region only
 * announces changes to a region that already exists. `role="status"` is a
 * polite live region: it speaks when the person pauses and never moves focus.
 */
export const SaveStatusLine = ({ id, status }: SaveStatusLineProps) => (
  <p
    className={`curation__status${status.kind === "failed" ? " curation__status--failed" : ""}`}
    id={id}
    role="status"
  >
    {text(status)}
  </p>
);
