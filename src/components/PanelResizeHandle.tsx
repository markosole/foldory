import { useEffect, useRef, useState } from "react";

const MIN_WIDTH = 100;
const MAX_WIDTH = 420;
export function usePanelWidth(
  key: string,
  fallback: number,
  min = MIN_WIDTH,
  max = MAX_WIDTH,
) {
  const [width, setWidth] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved !== null && Number.isFinite(Number(saved))
        ? Math.max(min, Math.min(max, Number(saved)))
        : fallback;
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, String(width));
    } catch {
      /* Layout still works when storage is unavailable. */
    }
  }, [key, width]);
  return [width, setWidth] as const;
}

export default function PanelResizeHandle({
  width,
  onResize,
  label,
  controls,
  min = MIN_WIDTH,
  max = MAX_WIDTH,
  edge = "right",
}: {
  width: number;
  onResize: (width: number) => void;
  label: string;
  controls: string;
  min?: number;
  max?: number;
  edge?: "left" | "right";
}) {
  const constrain = (value: number) => Math.max(min, Math.min(max, value));
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    document.body.classList.add("resizing-panels");
    return () => document.body.classList.remove("resizing-panels");
  }, [dragging]);
  return (
    <div
      className={`panel-resize-handle ${edge === "left" ? "resize-from-left" : ""} ${dragging ? "dragging" : ""}`}
      role="separator"
      aria-label={label}
      aria-controls={controls}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      title={`${label} (${min}–${max}px)`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (drag.current)
          onResize(
            constrain(
              drag.current.width +
                (event.clientX - drag.current.x) * (edge === "left" ? -1 : 1),
            ),
          );
      }}
      onPointerUp={(event) => {
        drag.current = null;
        setDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        setDragging(false);
      }}
      onKeyDown={(event) => {
        const next =
          event.key === "Home"
            ? min
            : event.key === "End"
              ? max
              : event.key === "ArrowLeft"
                ? width -
                  (event.shiftKey ? 25 : 10) * (edge === "left" ? -1 : 1)
                : event.key === "ArrowRight"
                  ? width +
                    (event.shiftKey ? 25 : 10) * (edge === "left" ? -1 : 1)
                  : null;
        if (next !== null) {
          event.preventDefault();
          onResize(constrain(next));
        }
      }}
    />
  );
}
