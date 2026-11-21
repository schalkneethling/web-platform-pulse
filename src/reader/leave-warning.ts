import { useEffect } from "react";

/**
 * Asks the browser to confirm before the page is closed, reloaded or left,
 * while `pending` is true, and not at all otherwise.
 *
 * The handler is registered only while something is pending. Some browsers
 * will not keep a page that has a `beforeunload` listener for instant back and
 * forward navigation, so a page that always held one would pay that cost for
 * no reason. Calling `preventDefault()` is how the HTML standard asks for the
 * prompt; the older `returnValue` assignment is marked deprecated in the DOM
 * typings. The browser shows its own wording, which a page cannot change.
 */
export const useLeaveWarning = (pending: boolean): void => {
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);
};
