import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle } from "lucide-react";
import Modal from "./Modal";

export type DialogAction = {
  value: string;
  label: string;
  description?: string;
  variant?: "default" | "primary" | "danger";
};

export type DialogOptions = {
  title: string;
  message: string;
  actions: DialogAction[];
  cancelLabel?: string;
};

export type ConfirmOptions = Omit<DialogOptions, "actions"> & {
  confirmLabel?: string;
  danger?: boolean;
};

type PendingDialog = DialogOptions & {
  resolve: (value: string | null) => void;
};

type DialogContextValue = {
  choose: (options: DialogOptions) => Promise<string | null>;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
};

const unavailable: DialogContextValue = {
  choose: async () => null,
  confirm: async () => false,
};

const DialogContext = createContext<DialogContextValue>(unavailable);

export function AppDialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingDialog | null>(null);
  const pendingRef = useRef<PendingDialog | null>(null);

  useEffect(
    () => () => {
      pendingRef.current?.resolve(null);
      pendingRef.current = null;
    },
    [],
  );

  const choose = useCallback(
    (options: DialogOptions) =>
      new Promise<string | null>((resolve) => {
        pendingRef.current?.resolve(null);
        const next = { ...options, resolve };
        pendingRef.current = next;
        setPending(next);
      }),
    [],
  );

  const finish = useCallback((value: string | null) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(value);
  }, []);

  const confirm = useCallback(
    async (options: ConfirmOptions) =>
      (await choose({
        title: options.title,
        message: options.message,
        cancelLabel: options.cancelLabel,
        actions: [
          {
            value: "confirm",
            label: options.confirmLabel || "Continue",
            variant: options.danger ? "danger" : "primary",
          },
        ],
      })) === "confirm",
    [choose],
  );

  const value = useMemo(() => ({ choose, confirm }), [choose, confirm]);
  const describedActions = pending?.actions.some(
    (action) => action.description,
  );

  return (
    <DialogContext.Provider value={value}>
      {children}
      {pending && (
        <Modal
          title={pending.title}
          className="app-dialog"
          onClose={() => finish(null)}
        >
          <div className="app-dialog-copy">
            <AlertTriangle size={20} aria-hidden="true" />
            <p>{pending.message}</p>
          </div>
          {describedActions ? (
            <div className="dialog-choice-list">
              {pending.actions.map((action) => (
                <button
                  key={action.value}
                  className={`dialog-choice ${action.variant || "default"}`}
                  onClick={() => finish(action.value)}
                >
                  <strong>{action.label}</strong>
                  {action.description && <span>{action.description}</span>}
                </button>
              ))}
            </div>
          ) : (
            <div className="modal-actions">
              <button className="button" onClick={() => finish(null)}>
                {pending.cancelLabel || "Cancel"}
              </button>
              {pending.actions.map((action) => (
                <button
                  key={action.value}
                  className={`button ${action.variant || ""}`}
                  onClick={() => finish(action.value)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
          {describedActions && (
            <div className="modal-actions">
              <button className="button" onClick={() => finish(null)}>
                {pending.cancelLabel || "Cancel"}
              </button>
            </div>
          )}
        </Modal>
      )}
    </DialogContext.Provider>
  );
}

export function useAppDialog() {
  return useContext(DialogContext);
}
