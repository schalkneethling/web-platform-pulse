import { useEffect, useRef, useState } from "react";
import { formatUtcDate } from "../core/dates.ts";
import { CurationItem, type SavedItem } from "./curation-item.tsx";
import { useLeaveWarning } from "./leave-warning.ts";
import { saveHeading, type CurationDraft } from "./issue-source.ts";
import { SaveStatusLine } from "./save-status.tsx";
import { getCuratorClient } from "./supabase.ts";
import { useSaver } from "./use-saver.ts";

/** How many events that are not in the issue are listed at first, and per press of "Show more". */
const PAGE = 50;

/** The caps migration 9 puts on the heading. They only stop typing at the
 * limit; the database remains the authority. */
const TITLE_MAX_LENGTH = 200;
const INTRO_MAX_LENGTH = 4000;

/** The title and the intro. Each saves on blur, and only the one whose text changed is sent. */
const Heading = ({
  draft,
  onPending,
}: {
  draft: CurationDraft;
  onPending: (id: string, pending: boolean) => void;
}) => {
  const [title, setTitle] = useState(draft.title);
  const [intro, setIntro] = useState(draft.intro);
  const wanted = useRef({ title: draft.title, intro: draft.intro });
  const saved = useRef({ title: draft.title.trim(), intro: draft.intro.trim() });
  const [savedHeading, setSavedHeading] = useState({
    title: draft.title.trim(),
    intro: draft.intro.trim(),
  });
  const { status, save } = useSaver();

  // A write in flight, or text on screen that differs from what is saved.
  const pending =
    status.kind === "saving" ||
    title.trim() !== savedHeading.title ||
    intro.trim() !== savedHeading.intro;
  useEffect(() => {
    onPending("heading", pending);
    return () => onPending("heading", false);
  }, [pending]);

  const saveText = () =>
    save(() => {
      const title = wanted.current.title.trim();
      const intro = wanted.current.intro.trim();
      const titleChanged = title !== saved.current.title;
      const introChanged = intro !== saved.current.intro;
      if (!titleChanged && !introChanged) return null;
      return async () => {
        // Only the field that changed is sent: the database leaves the other
        // as it is, so a page that is out of date cannot overwrite it.
        const result = await saveHeading(getCuratorClient(), draft.id, {
          ...(titleChanged ? { title: wanted.current.title } : {}),
          ...(introChanged ? { intro: wanted.current.intro } : {}),
        });
        if (result.ok) {
          if (titleChanged) saved.current.title = title;
          if (introChanged) saved.current.intro = intro;
          setSavedHeading({ ...saved.current });
        }
        return result;
      };
    });

  return (
    <fieldset className="curation__heading" aria-describedby="heading-status">
      <legend className="curation__legend">Heading</legend>
      <div className="curation__field">
        <label htmlFor="issue-title">Title</label>
        <input
          id="issue-title"
          type="text"
          maxLength={TITLE_MAX_LENGTH}
          value={title}
          onChange={(e) => {
            setTitle(e.currentTarget.value);
            wanted.current.title = e.currentTarget.value;
          }}
          onBlur={saveText}
        />
      </div>
      <div className="curation__field">
        <label htmlFor="issue-intro">Intro</label>
        <textarea
          id="issue-intro"
          rows={5}
          maxLength={INTRO_MAX_LENGTH}
          value={intro}
          onChange={(e) => {
            setIntro(e.currentTarget.value);
            wanted.current.intro = e.currentTarget.value;
          }}
          onBlur={saveText}
        />
      </div>
      <SaveStatusLine id="heading-status" status={status} />
    </fieldset>
  );
};

/**
 * The draft being curated.
 *
 * The list is ordered once, when the draft loads (see `toCurationDraft`), and
 * the order and the set of visible events are fixed by that load plus the
 * "Show more" presses. Including or excluding an event does not move it. A row
 * that jumped to the top the moment it was ticked would take the keyboard
 * focus with it, and a person ticking three events in a row would be chasing
 * them. The next visit shows the included ones first.
 */
export const CurationEditor = ({ draft }: { draft: CurationDraft }) => {
  const [limit, setLimit] = useState(PAGE);
  // What the database holds for each event, for the count. Seeded from the
  // load and updated only after a write succeeded.
  const [saved, setSaved] = useState<Record<string, SavedItem>>(() =>
    Object.fromEntries(
      draft.events.map(({ event, included, note }) => [event.id, { included, note: note.trim() }]),
    ),
  );
  const revealed = useRef<string | null>(null);

  // Which field groups have changes that are not saved yet, so the page can
  // warn before it is left. The warning is registered only while one does.
  const [pendingGroups, setPendingGroups] = useState<ReadonlySet<string>>(new Set());
  const reportPending = (id: string, pending: boolean) =>
    setPendingGroups((current) => {
      if (current.has(id) === pending) return current;
      const next = new Set(current);
      if (pending) next.add(id);
      else next.delete(id);
      return next;
    });
  useLeaveWarning(pendingGroups.size > 0);

  const includedAtLoad = draft.events.filter((entry) => entry.included);
  const rest = draft.events.filter((entry) => !entry.included);
  const visible = [...includedAtLoad, ...rest.slice(0, limit)];
  const hidden = rest.length - Math.min(limit, rest.length);

  const showMore = () => {
    // Keyboard focus moves to the first event the press revealed: the button
    // disappears when nothing is left, and focus on a removed element is lost.
    revealed.current = rest[limit]?.event.id ?? null;
    setLimit(limit + PAGE);
  };

  useEffect(() => {
    if (revealed.current === null) return;
    document.getElementById(`include-${revealed.current}`)?.focus();
    revealed.current = null;
  }, [limit]);

  const includedNow = Object.values(saved).filter((item) => item.included);
  const withNote = includedNow.filter((item) => item.note !== "").length;

  return (
    <form className="curation" onSubmit={(e) => e.preventDefault()} aria-labelledby="curate-title">
      <h3 className="curation__title" id="curate-title">
        Issue #{draft.number} (draft)
      </h3>
      <p className="curation__window">
        Covering <time dateTime={draft.windowStart}>{formatUtcDate(draft.windowStart)}</time> to{" "}
        <time dateTime={draft.windowEnd}>{formatUtcDate(draft.windowEnd)}</time> (UTC). Changes save
        as you make them.
      </p>
      <Heading draft={draft} onPending={reportPending} />
      <p className="curation__count">
        {withNote} of {includedNow.length} included items have a note.
      </p>
      <p className="curation__shown" role="status">
        Showing {visible.length} of {draft.events.length} events from this window.
      </p>
      {draft.events.length === 0 && <p>No events were observed in this window.</p>}
      <ol className="curation__items">
        {visible.map((entry) => (
          <CurationItem
            key={entry.event.id}
            issueId={draft.id}
            entry={entry}
            onSaved={(id, item) => setSaved((current) => ({ ...current, [id]: item }))}
            onPending={reportPending}
          />
        ))}
      </ol>
      {hidden > 0 && (
        <button className="button" type="button" onClick={showMore}>
          Show {Math.min(PAGE, hidden)} more ({hidden} not shown)
        </button>
      )}
    </form>
  );
};
