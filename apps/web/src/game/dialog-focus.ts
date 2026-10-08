// Keyboard focus for the in-game dialogs (C-A11Y): opening a dialog moves focus into it, Tab and Shift+Tab stay inside
// it, Escape closes it when it can be cancelled, and closing it returns focus to the element that had it before. The
// board hides its targets while a dialog is open, so a board target that opened the dialog is found again by its
// data-target-* attribute; when there is no such element any more, focus goes to the fallback (e.g. the game panel).
import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

const TARGET_ATTRS = ['data-target-hex', 'data-target-vertex', 'data-target-edge'] as const;

/** The element that had focus before the dialog, or its replacement after the board re-rendered its targets. */
function returnTarget(previous: Element | null, key: readonly [string, string] | null): HTMLElement | SVGElement | null {
  if (previous?.isConnected && (previous instanceof HTMLElement || previous instanceof SVGElement)) return previous;
  if (key === null) return null;
  return document.querySelector<HTMLElement | SVGElement>(`[${key[0]}="${CSS.escape(key[1])}"]`);
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[hidden]'));
}

export interface DialogFocus {
  readonly ref: RefObject<HTMLDivElement>;
  /** The dialog's keydown handler: the Tab trap and, when `onEscape` is given, Escape. */
  onKeyDown(e: KeyboardEvent<HTMLDivElement>): void;
}

/**
 * Focus handling for one dialog while it is mounted. `onEscape` closes a cancellable dialog; `fallback` receives focus
 * on close when the previously focused element is no longer in the document.
 */
export function useDialogFocus(opts: { onEscape?: () => void; fallback?: () => HTMLElement | null } = {}): DialogFocus {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(opts);
  latest.current = opts;
  // Read during the first render, before the commit that mounts the dialog: that commit can remove the element that
  // had focus (the board hides its targets while a dialog is open).
  const opener = useRef<Element | null | undefined>(undefined);
  if (opener.current === undefined) opener.current = typeof document === 'undefined' ? null : document.activeElement;

  useEffect(() => {
    const previous = opener.current ?? null;
    const attr = previous ? TARGET_ATTRS.find((a) => previous.hasAttribute(a)) : undefined;
    const key = previous && attr ? ([attr, previous.getAttribute(attr)!] as const) : null;
    const dialog = ref.current;
    if (dialog) (focusables(dialog)[0] ?? dialog).focus();
    return () => {
      const back = returnTarget(previous, key) ?? latest.current.fallback?.() ?? null;
      back?.focus();
    };
  }, []);

  return {
    ref,
    onKeyDown(e) {
      const dialog = ref.current;
      if (!dialog) return;
      if (e.key === 'Escape' && latest.current.onEscape) {
        e.preventDefault();
        latest.current.onEscape();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables(dialog);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !dialog.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    },
  };
}
