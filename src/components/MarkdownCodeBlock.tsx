import {
  Children,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, Copy } from "lucide-react";
import "./markdown-code-block.css";

export default function MarkdownCodeBlock({
  children,
}: {
  children: ReactNode;
}) {
  const pre = useRef<HTMLPreElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const element = Children.toArray(children).find((child) =>
    isValidElement(child),
  );
  const className = isValidElement<{ className?: string }>(element)
    ? element.props.className
    : "";
  const language = className?.match(/(?:^|\s)language-([^\s]+)/)?.[1];
  const label = /^(md|markdown)$/i.test(language || "")
    ? "Markdown"
    : language || "code";
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(pre.current?.textContent || "");
      setError("");
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(
        "Could not copy this block. Select its text and copy it manually.",
      );
    }
  }
  return (
    <div className="markdown-code-block">
      <div className="markdown-code-toolbar">
        <span>{label === "code" ? "Code" : label}</span>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={`Copy ${label}`}
          title={`Copy ${label}`}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span role="status">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre ref={pre}>{children}</pre>
      {error && (
        <p className="markdown-copy-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
