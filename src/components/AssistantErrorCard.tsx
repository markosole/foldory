import { useId } from "react";
import {
  AlertCircle,
  Clock3,
  Database,
  FileWarning,
  KeyRound,
  PlugZap,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { toAppError, type AppErrorCode, type ErrorContext } from "../errors";
import "./assistant-errors.css";

function errorIcon(code: AppErrorCode) {
  if (code === "database_busy") return Database;
  if (code === "request_timeout") return Clock3;
  if (code === "ai_auth") return KeyRound;
  if (code === "permission") return ShieldAlert;
  if (code === "ai_connection" || code === "ai_model_unavailable")
    return PlugZap;
  if (
    code === "source_expired" ||
    code === "source_limit" ||
    code === "file_access"
  )
    return FileWarning;
  return AlertCircle;
}

export default function AssistantErrorCard({
  error,
  context,
  onRetry,
}: {
  error: unknown;
  context?: ErrorContext;
  onRetry?: () => void;
}) {
  const titleId = useId();
  const descriptor = toAppError(error, context);
  const Icon = errorIcon(descriptor.code);
  return (
    <div
      className="assistant-error-card"
      data-error-code={descriptor.code}
      role="alert"
      aria-labelledby={titleId}
    >
      <Icon className="assistant-error-icon" size={19} aria-hidden="true" />
      <div className="assistant-error-body">
        <span className="assistant-error-category">{descriptor.category}</span>
        <h3 id={titleId}>{descriptor.title}</h3>
        <p>{descriptor.message}</p>
        <p className="assistant-error-action">{descriptor.action}</p>
        {descriptor.retryable && onRetry && (
          <button
            className="button small assistant-error-retry"
            type="button"
            onClick={onRetry}
          >
            <RefreshCw size={13} aria-hidden="true" /> Try again
          </button>
        )}
        {descriptor.technicalDetails && (
          <details className="assistant-error-details">
            <summary>Technical details</summary>
            <pre>{descriptor.technicalDetails}</pre>
            <span className="assistant-error-code">
              Code: {descriptor.code}
            </span>
          </details>
        )}
      </div>
    </div>
  );
}
