import { toast as hot } from "react-hot-toast";

// Every transient outcome goes through here, so the viewer has one voice for "that worked" and
// "that did not" instead of a notice bar per view.
//
// What belongs in a toast: the result of something you just pressed. What does not: state you
// need to keep reading, like a reconcile report or a run that is still going. Those stay on the page,
// because a message that disappears cannot be the only record of an outcome you have to act on.
//
// Styling is left to CSS on the toast container rather than inline style objects, so the light
// and dark themes keep working from the same tokens as the rest of the app.

const BASE = { className: "toast", position: "bottom-right" } as const;

/** Something finished and there is nothing to do about it. */
export function toastDone(message: string): void {
  hot.success(message, { ...BASE, className: "toast toastDone", duration: 4000 });
}

/**
 * Something failed. Held longer than a success and dismissible, because an error the user missed
 * is an error they will hit again.
 */
export function toastFailed(message: string): void {
  hot.error(message, { ...BASE, className: "toast toastFailed", duration: 8000 });
}

/** A plain statement of fact: how many, how much, what was skipped. */
export function toastSaid(message: string): void {
  hot(message, { ...BASE, className: "toast toastSaid", duration: 5000 });
}

export { Toaster } from "react-hot-toast";
