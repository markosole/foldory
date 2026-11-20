import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ImageOff,
  LoaderCircle,
} from "lucide-react";
import { api } from "../api";
import { isPreviewImage } from "../fileSettings";

export default function ImagePreview({
  projectId,
  path,
  onNavigate,
  refreshVersion = 0,
}: {
  projectId: string;
  path: string;
  onNavigate: (path: string) => void;
  refreshVersion?: number;
}) {
  const root = useRef<HTMLElement | null>(null);
  const [image, setImage] = useState("");
  const [siblings, setSiblings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [navigationError, setNavigationError] = useState("");
  const [dimensions, setDimensions] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setImage("");
    setError("");
    setDimensions("");
    api
      .readImage(projectId, path)
      .then((value) => {
        if (active) setImage(value);
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    root.current?.focus({ preventScroll: true });
    return () => {
      active = false;
    };
  }, [projectId, path, refreshVersion, attempt]);
  const directory = path.split("/").slice(0, -1).join("/");
  useEffect(() => {
    let active = true;
    setSiblings([]);
    setNavigationError("");
    api
      .listDirectory(projectId, directory)
      .then((entries) => {
        if (active)
          setSiblings(
            entries
              .filter((entry) => !entry.directory && isPreviewImage(entry.path))
              .map((entry) => entry.path),
          );
      })
      .catch((reason) => {
        if (active)
          setNavigationError(`Could not list nearby images. ${String(reason)}`);
      });
    return () => {
      active = false;
    };
  }, [projectId, directory, refreshVersion, attempt]);
  const index = siblings.indexOf(path);
  const canNavigate = index >= 0 && siblings.length > 1;
  function move(direction: number) {
    if (canNavigate)
      onNavigate(
        siblings[(index + direction + siblings.length) % siblings.length],
      );
  }
  return (
    <section
      ref={root}
      className="document-editor image-preview"
      tabIndex={0}
      aria-label={`Image preview for ${path}`}
      onKeyDown={(event) => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          move(event.key === "ArrowLeft" ? -1 : 1);
        }
      }}
    >
      <div className="editor-toolbar image-preview-toolbar">
        <span className="editor-filename" title={path}>
          {path}
        </span>
        <div
          className="image-navigation"
          role="group"
          aria-label="Browse images"
        >
          <button
            type="button"
            className="icon-button small"
            aria-label="Previous image"
            title="Previous image (←)"
            disabled={!canNavigate}
            onClick={() => move(-1)}
          >
            <ChevronLeft size={18} />
          </button>
          <span>
            {index >= 0 ? `${index + 1} / ${siblings.length}` : "Image"}
          </span>
          <button
            type="button"
            className="icon-button small"
            aria-label="Next image"
            title="Next image (→)"
            disabled={!canNavigate}
            onClick={() => move(1)}
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>
      {navigationError && (
        <div className="editor-notice error" role="status">
          {navigationError}
        </div>
      )}
      {error ? (
        <div className="empty-state" role="alert">
          <ImageOff size={32} />
          <p>{error}</p>
          <button
            className="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry image
          </button>
        </div>
      ) : !image ? (
        <div className="workspace-loading" role="status">
          <LoaderCircle size={18} className="spin" />
          Loading image…
        </div>
      ) : (
        <div className="image-preview-surface">
          <img
            src={image}
            alt={path.split("/").pop()}
            onLoad={(event) => {
              const image = event.currentTarget;
              setDimensions(
                `${image.naturalWidth} × ${image.naturalHeight} px`,
              );
            }}
            onError={() =>
              setError(
                "This image could not be decoded. Open it in the default app or try another image.",
              )
            }
          />
        </div>
      )}
      <footer className="editor-footer">
        <span>{dimensions}</span>
        <span>PNG / JPEG · Use ← / → to browse this folder</span>
      </footer>
    </section>
  );
}
