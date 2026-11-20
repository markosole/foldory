import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
export default function Modal({
  title,
  children,
  onClose,
  wide = false,
  className = "",
  hideCloseButton = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  className?: string;
  hideCloseButton?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => {
      node?.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      className={`modal ${wide ? "wide" : ""} ${className}`}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="modal-heading">
        <h2 id={titleId}>{title}</h2>
        {!hideCloseButton && (
          <button
            className="icon-button"
            title="Close"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        )}
      </div>
      {children}
    </dialog>
  );
}
