import { useRef, useState } from "react";
import { SECTION_LABELS, SECTION_ORDER, sectionFor, type Section } from "../core/issue.ts";
import { sourceName } from "../core/provenance.ts";
import { excludeEvent, includeEvent, saveNote, type CurationEvent } from "./issue-source.ts";
import { SaveStatusLine } from "./save-status.tsx";
import { getCuratorClient } from "./supabase.ts";
import { useSaver } from "./use-saver.ts";

/** The database caps a note at 2000 characters (migration 9); this only stops
 * typing at the limit, and the database remains the authority. */
const NOTE_MAX_LENGTH = 2000;

export interface SavedItem {
  included: boolean;
  note: string;
}

interface CurationItemProps {
  issueId: string;
  entry: CurationEvent;
  /** Called after a write succeeded, with what the database now holds. */
  onSaved: (eventId: string, saved: SavedItem) => void;
}

/**
 * One event of the window. Include saves on change, section on change, and the
 * note on blur when its text differs from what is saved.
 *
 * Two copies of each value exist on purpose. The state drives what is drawn.
 * `wanted` is what the person last asked for, and `saved` is what the database
 * is known to hold; the queued writes in `useSaver` compare them when their
 * turn comes. Neither the row nor its controls are ever remounted by a save,
 * so keyboard focus stays on the control that was edited.
 */
export const CurationItem = ({ issueId, entry, onSaved }: CurationItemProps) => {
  const { event } = entry;
  const [included, setIncluded] = useState(entry.included);
  const [section, setSection] = useState<Section>(entry.section);
  const [note, setNote] = useState(entry.note);
  const [savedNote, setSavedNote] = useState(entry.note.trim());
  const { status, save } = useSaver();

  const wanted = useRef({ included: entry.included, section: entry.section, note: entry.note });
  const saved = useRef({
    hasRow: entry.hasRow,
    included: entry.included,
    section: entry.section,
    note: entry.note.trim(),
  });

  const fieldId = (name: string) => `${name}-${event.id}`;
  const statusId = fieldId("status");

  const changeIncluded = (next: boolean) => {
    setIncluded(next);
    wanted.current.included = next;
    save(() => {
      const target = wanted.current.included;
      if (target === saved.current.included) return null;
      return async () => {
        const client = getCuratorClient();
        const result = target
          ? await includeEvent(client, issueId, event.id)
          : await excludeEvent(client, issueId, event.id);
        if (result.ok) {
          saved.current.included = target;
          // Including inserts a row with the section for the event's type;
          // excluding never removes the row, so a note survives a round trip.
          if (target && !saved.current.hasRow) {
            saved.current.hasRow = true;
            saved.current.section = sectionFor(event, false);
          }
          onSaved(event.id, { included: target, note: saved.current.note });
        } else {
          // The checkbox must not claim a state the database does not hold.
          wanted.current.included = saved.current.included;
          setIncluded(saved.current.included);
        }
        return result;
      };
    });
  };

  /** Writes the note and section together: the function takes both, and the
   * one a person did not touch is whatever is on screen. */
  const saveText = () =>
    save(() => {
      const { note: text, section: target } = wanted.current;
      if (
        !saved.current.hasRow ||
        (text.trim() === saved.current.note && target === saved.current.section)
      ) {
        return null;
      }
      return async () => {
        const result = await saveNote(getCuratorClient(), issueId, event.id, text, target);
        if (result.ok) {
          saved.current.note = text.trim();
          saved.current.section = target;
          setSavedNote(saved.current.note);
          onSaved(event.id, { included: saved.current.included, note: saved.current.note });
        }
        return result;
      };
    });

  const changeSection = (next: Section) => {
    setSection(next);
    wanted.current.section = next;
    saveText();
  };

  const changeNote = (next: string) => {
    setNote(next);
    wanted.current.note = next;
  };

  const first = event.provenance[0];
  const host = first ? sourceName(first.url) : null;
  const href = first && /^https?:\/\//i.test(first.url) ? first.url : null;

  return (
    <li className="curation-item">
      <fieldset className="curation-item__fieldset" aria-describedby={statusId}>
        <legend className="curation-item__legend">
          {href ? (
            <a className="curation-item__link" href={href}>
              {event.title}
            </a>
          ) : (
            event.title
          )}
          {host && <span className="curation-item__source"> ({host})</span>}
        </legend>
        <div className="curation-item__row">
          <input
            id={fieldId("include")}
            type="checkbox"
            checked={included}
            onChange={(e) => changeIncluded(e.currentTarget.checked)}
          />
          <label htmlFor={fieldId("include")}>Include in the issue</label>
          {included && savedNote === "" && <span className="curation-item__flag">No note yet</span>}
        </div>
        {included && (
          <>
            <div className="curation__field">
              <label htmlFor={fieldId("section")}>Section</label>
              <select
                id={fieldId("section")}
                value={section}
                onChange={(e) => changeSection(e.currentTarget.value as Section)}
              >
                {SECTION_ORDER.map((value) => (
                  <option key={value} value={value}>
                    {SECTION_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
            <div className="curation__field">
              <label htmlFor={fieldId("note")}>Note</label>
              <textarea
                id={fieldId("note")}
                rows={3}
                maxLength={NOTE_MAX_LENGTH}
                value={note}
                onChange={(e) => changeNote(e.currentTarget.value)}
                onBlur={saveText}
              />
            </div>
          </>
        )}
        <SaveStatusLine id={statusId} status={status} />
      </fieldset>
    </li>
  );
};
