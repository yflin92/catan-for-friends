// An in-game dialog: role="dialog" with its label, modal for keyboard users (focus moves in, stays in, and returns on
// close; see dialog-focus.ts). Escape cancels when `onEscape` is given. Without a previous focus target, focus returns
// to the game panel.
import type { ReactNode } from 'react';
import { useDialogFocus } from './dialog-focus';

const panel = (): HTMLElement | null => document.querySelector<HTMLElement>('.game-panel');

export function Dialog({ label, className = 'confirm', onEscape, children }: { label: string; className?: string; onEscape?: () => void; children: ReactNode }) {
  const focus = useDialogFocus({ ...(onEscape ? { onEscape } : {}), fallback: panel });
  return (
    <div ref={focus.ref} className={className} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={focus.onKeyDown}>
      {children}
    </div>
  );
}
