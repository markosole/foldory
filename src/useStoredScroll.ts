import { useCallback, useRef } from "react";
import { readPreference, writePreference } from "./useWorkspaceSession";

/** Restore after asynchronous content/layout arrives, until the user scrolls. */
export function useStoredScroll(key: string, enabled = true) {
  const cleanup = useRef<(() => void) | undefined>(undefined);
  return useCallback(
    (node: HTMLElement | null) => {
      cleanup.current?.();
      cleanup.current = undefined;
      if (!node || !enabled) return;
      const saved = readPreference<{ top?: number; left?: number } | null>(
        key,
        null,
      );
      const top = Number.isFinite(saved?.top) ? Math.max(0, saved!.top!) : 0;
      const left = Number.isFinite(saved?.left) ? Math.max(0, saved!.left!) : 0;
      let restoring = true;
      let frame: number | undefined;
      const restore = () => {
        if (!restoring) return;
        cancelAnimationFrame(frame!);
        node.scrollTop = top;
        node.scrollLeft = left;
        // Expanding an asynchronously loaded tree can trigger browser scroll
        // anchoring after the DOM mutation. Confirm the position next frame.
        frame = requestAnimationFrame(() => {
          if (!restoring) return;
          node.scrollTop = top;
          node.scrollLeft = left;
          if (
            Math.abs(node.scrollTop - top) < 1 &&
            Math.abs(node.scrollLeft - left) < 1
          )
            restoring = false;
        });
      };
      const remember = () => {
        if (!restoring)
          writePreference(key, { top: node.scrollTop, left: node.scrollLeft });
      };
      const interact = () => {
        restoring = false;
      };
      node.addEventListener("scroll", remember, { passive: true });
      for (const type of ["wheel", "pointerdown", "keydown", "touchstart"])
        node.addEventListener(type, interact, { passive: true });
      const mutations = new MutationObserver(restore);
      mutations.observe(node, { childList: true, subtree: true });
      const resize =
        typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver(restore);
      resize?.observe(node);
      restore();
      cleanup.current = () => {
        cancelAnimationFrame(frame!);
        mutations.disconnect();
        resize?.disconnect();
        node.removeEventListener("scroll", remember);
        for (const type of ["wheel", "pointerdown", "keydown", "touchstart"])
          node.removeEventListener(type, interact);
      };
    },
    [key, enabled],
  );
}
