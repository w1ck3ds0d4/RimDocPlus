import { useCallback, useEffect, useState, type ReactNode } from "react";

export interface ConfirmOptions {
  title: string;
  /** What will happen, in enough detail to answer without leaving the dialog. */
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the action red. Set when the result cannot be undone. */
  destructive?: boolean;
}

interface Request extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

/**
 * Ask before doing something that cannot be taken back.
 *
 * Returns a promise so a caller reads as `if (await confirm(...))` rather than being
 * turned inside out into callbacks, and renders its own dialog so a component only has
 * to place `{dialog}` once regardless of how many things it guards.
 */
export function useConfirm() {
  const [request, setRequest] = useState<Request | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setRequest({ ...options, resolve })),
    [],
  );

  const close = useCallback(
    (ok: boolean) => {
      request?.resolve(ok);
      setRequest(null);
    },
    [request],
  );

  const dialog = request ? <ConfirmDialog request={request} onClose={close} /> : null;
  return { confirm, dialog };
}

function ConfirmDialog({ request, onClose }: { request: Request; onClose: (ok: boolean) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape cancels; Enter is deliberately not bound, so a destructive action always
      // needs a deliberate click rather than a stray keypress.
      if (e.key === "Escape") onClose(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onClick={() => onClose(false)}>
      <div
        className="modal confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id="confirm-title">{request.title}</h2>
        </div>
        <div className="modal-body">{request.body}</div>
        <div className="modal-foot">
          <button
            className={`btn${request.destructive ? " danger" : " primary"}`}
            type="button"
            autoFocus
            onClick={() => onClose(true)}
          >
            {request.confirmLabel ?? "Confirm"}
          </button>
          <button className="btn" type="button" onClick={() => onClose(false)}>
            {request.cancelLabel ?? "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}
