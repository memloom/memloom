import { useEffect, useRef } from "react";

// A modal for the handful of actions that cannot be undone. It has room to say what will be
// lost, and it makes the confirm a separate, deliberate target rather than a second click on
// the button that started it.
//
// Reserved for the irreversible. Anything with an undo should just do the thing and offer the
// undo, because a confirmation on a reversible action is a tax on every use to prevent a mistake
// that costs one click to fix.

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  danger,
}: {
  open: boolean;
  title: string;
  /** What will actually happen, in the user's terms. Not "are you sure". */
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Colours the confirm as destructive. */
  danger?: boolean;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Escape cancels, and focus starts on Cancel so a stray Enter does nothing. The safe choice is
  // the one your hands are already on.
  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="modalBackdrop">
      {/*
        A real button rather than a div with a click handler. Clicking outside to dismiss is a
        mouse convenience, and a button gets keyboard and screen-reader support for free instead
        of needing a11y rules suppressed. Escape closes it too, so this is never the only way out.
      */}
      <button
        type="button"
        className="modalScrim"
        aria-label="Cancel"
        tabIndex={-1}
        onClick={onCancel}
      />
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h3 className="modalTitle">{title}</h3>
        <p className="modalBody">{body}</p>
        <div className="modalActions">
          <button type="button" className="btn" ref={cancelRef} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${danger ? "btnDanger" : "btnPrimary"}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
