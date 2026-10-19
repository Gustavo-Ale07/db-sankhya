import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

interface Props {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  testId?: string;
}

/** Native <dialog>: focus trapping, Esc to close and inert background come from the browser. */
export function Modal({ open, title, onClose, children, footer, wide, testId }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-labelledby="modal-title"
      data-testid={testId}
      className={`m-auto max-h-[90vh] w-[95vw] rounded-lg border border-line bg-panel p-0 text-fg shadow-xl backdrop:bg-black/40 ${
        wide ? 'max-w-5xl' : 'max-w-lg'
      }`}
    >
      {open && (
        <div className="flex max-h-[90vh] flex-col">
          <div className="flex items-center border-b border-line px-4 py-2">
            <h2 id="modal-title" className="font-semibold">
              {title}
            </h2>
            <button
              type="button"
              className="ml-auto rounded px-2 text-lg leading-none text-muted hover:bg-hover"
              onClick={onClose}
              aria-label="Fechar"
            >
              ×
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-4 py-3">{children}</div>
          {footer && (
            <div className="flex justify-end gap-2 border-t border-line px-4 py-2">{footer}</div>
          )}
        </div>
      )}
    </dialog>
  );
}
