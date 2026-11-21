import { useRef, useState } from "react";
import type { WriteResult } from "./issue-source.ts";

/** What a field group tells the person about its last write. */
export type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | {
      kind: "failed";
      message: string;
      /**
       * True when the failed write was a checkbox, which the page puts back to
       * what is saved. False when the person's typing is still on screen.
       */
      reverted: boolean;
    };

/** A write's outcome, plus whether the page undid the change it was making. */
export type SaveResult = WriteResult & { reverted?: boolean };

/**
 * What a status line says. The two failures are told apart because what the
 * person must do differs: after a failed note, their text is still there to
 * save again; after a failed include or exclude, the checkbox has gone back
 * and nothing they typed is involved. The words "Not saved" carry the failure.
 */
export const saveStatusText = (status: SaveStatus): string => {
  switch (status.kind) {
    case "idle":
      return "";
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved.";
    case "failed":
      return status.reverted
        ? `Not saved: ${status.message} The checkbox is back to what is saved.`
        : `Not saved: ${status.message} What you typed is still here.`;
  }
};

/**
 * Decides, at the moment its turn comes, what to write. It returns the write,
 * or null when the values on screen are already the saved ones.
 */
export type SavePlan = () => (() => Promise<SaveResult>) | null;

/**
 * Runs the writes of one group of fields one at a time, in the order they were
 * asked for, and reports the outcome of the latest.
 *
 * Without the queue, a blur and a select change a few milliseconds apart would
 * send two requests that can arrive out of order, and the older value could
 * overwrite the newer one. A plan reads the values to send when its turn
 * comes, not when it was queued, so a plan that follows another sees that
 * one's result and can find that nothing is left to write; in that case the
 * status is left as it was.
 */
export const useSaver = () => {
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  const tail = useRef<Promise<void>>(Promise.resolve());

  const save = (plan: SavePlan): void => {
    tail.current = tail.current.then(async () => {
      const write = plan();
      if (!write) return;
      setStatus({ kind: "saving" });
      const result = await write();
      setStatus(
        result.ok
          ? { kind: "saved" }
          : { kind: "failed", message: result.message, reverted: result.reverted ?? false },
      );
    });
  };

  return { status, save };
};
