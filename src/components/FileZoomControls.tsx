import { Minus, Plus, RotateCcw } from "lucide-react";

export default function FileZoomControls({
  target,
  size,
  resize,
  reset,
  changed,
}: {
  target: "editor" | "preview";
  size: number;
  resize: (direction: number) => void;
  reset: () => void;
  changed: boolean;
}) {
  return (
    <div
      className="file-zoom-controls"
      role="group"
      aria-label={`${target === "editor" ? "Editor" : "Preview"} font size`}
    >
      <button
        type="button"
        className="icon-button small"
        aria-label={`Decrease ${target} font size`}
        title="Decrease font size (Ctrl+−)"
        disabled={size <= 9}
        onClick={() => resize(-1)}
      >
        <Minus size={13} />
      </button>
      <span title={`${target === "editor" ? "Editor" : "Preview"} font size`}>
        {size}px
      </span>
      <button
        type="button"
        className="icon-button small"
        aria-label={`Increase ${target} font size`}
        title="Increase font size (Ctrl++)"
        disabled={size >= 46}
        onClick={() => resize(1)}
      >
        <Plus size={13} />
      </button>
      {changed && (
        <button
          type="button"
          className="icon-button small"
          aria-label="Reset zoom"
          title="Reset zoom (Ctrl+0)"
          onClick={reset}
        >
          <RotateCcw size={13} />
        </button>
      )}
    </div>
  );
}
