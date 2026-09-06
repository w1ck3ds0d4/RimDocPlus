import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

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
            className={`btn${request.destructive ? " danger solid" : " primary"}`}
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

export interface PromptOptions {
  title: string;
  label: string;
  initial?: string;
  confirmLabel?: string;
  /** Return a message to block submission, or null to allow it. */
  validate?: (value: string) => string | null;
}

interface PromptRequest extends PromptOptions {
  resolve: (value: string | null) => void;
}

/** Ask for a single line of text. Resolves to null when cancelled. */
export function usePrompt() {
  const [request, setRequest] = useState<PromptRequest | null>(null);

  const prompt = useCallback(
    (options: PromptOptions) => new Promise<string | null>((resolve) => setRequest({ ...options, resolve })),
    [],
  );

  const close = useCallback(
    (value: string | null) => {
      request?.resolve(value);
      setRequest(null);
    },
    [request],
  );

  const dialog = request ? <PromptDialog request={request} onClose={close} /> : null;
  return { prompt, dialog };
}

function PromptDialog({
  request,
  onClose,
}: {
  request: PromptRequest;
  onClose: (value: string | null) => void;
}) {
  const [value, setValue] = useState(request.initial ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const error = request.validate?.(value) ?? null;

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // Select rather than place a caret: renaming usually replaces the whole name.
    input.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function submit() {
    if (!error) onClose(value.trim());
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={() => onClose(null)}>
      <div
        className="modal confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id="prompt-title">{request.title}</h2>
        </div>
        <label className="prompt-field">
          <span>{request.label}</span>
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            // Enter is safe here: the action is a rename, not something destructive.
            onKeyDown={(e) => e.key === "Enter" && submit()}
            aria-invalid={!!error}
          />
        </label>
        {error && <p className="prompt-error">{error}</p>}
        <div className="modal-foot">
          <button className="btn primary" type="button" disabled={!!error} onClick={submit}>
            {request.confirmLabel ?? "Save"}
          </button>
          <button className="btn" type="button" onClick={() => onClose(null)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
