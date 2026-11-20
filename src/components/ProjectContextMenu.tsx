import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  FolderOpen,
  Palette,
  Pencil,
  Pin,
  Settings2,
  Terminal,
} from "lucide-react";
import type { Project, Settings } from "../types";
import { enabledLaunchers } from "../launchers";
import { projectName, projectColors } from "../utils";
import "./project-context-menu.css";

export interface ProjectMenuAnchor {
  projectId: string;
  x: number;
  y: number;
  trigger: HTMLElement;
  folderPath?: string;
}

export default function ProjectContextMenu({
  project,
  settings,
  anchor,
  onClose,
  onRename,
  onEdit,
  onColor,
  onPin,
  onHide,
  onLaunch,
  onOpenFolder,
  onCopyPath,
}: {
  project: Project;
  settings: Settings;
  anchor: ProjectMenuAnchor;
  onClose: () => void;
  onRename: () => void;
  onEdit: () => void;
  onColor: (color: string) => void;
  onPin: () => void;
  onHide: () => void;
  onLaunch: (tool: string) => void;
  onOpenFolder?: () => void;
  onCopyPath?: () => void;
}) {
  const nestedFolder = Boolean(anchor.folderPath);
  const targetName = nestedFolder
    ? anchor.folderPath!.split("/").pop()!
    : projectName(project);
  const menu = useRef<HTMLDivElement>(null);
  const [colorsOpen, setColorsOpen] = useState(false);
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const box = menu.current!.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(anchor.x, window.innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(anchor.y, window.innerHeight - box.height - 8)),
    });
  }, [anchor, colorsOpen, settings]);

  useLayoutEffect(() => {
    // A click may follow an automatic scroll-to-row before its scroll event is
    // delivered. Only close for movement occurring after the menu was opened.
    const scrollPositions = new Map<
      EventTarget,
      { top: number; left: number }
    >();
    for (
      let node: HTMLElement | null = anchor.trigger;
      node;
      node = node.parentElement
    ) {
      scrollPositions.set(node, { top: node.scrollTop, left: node.scrollLeft });
    }
    const windowPosition = { top: window.scrollY, left: window.scrollX };
    menu.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus({ preventScroll: true });
    const closeOutside = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) onCloseRef.current();
    };
    const closeOnScroll = (event: Event) => {
      if (menu.current?.contains(event.target as Node)) return;
      if (
        event.target === document &&
        window.scrollY === windowPosition.top &&
        window.scrollX === windowPosition.left
      )
        return;
      const previous = scrollPositions.get(event.target!);
      if (
        previous &&
        event.target instanceof HTMLElement &&
        previous.top === event.target.scrollTop &&
        previous.left === event.target.scrollLeft
      )
        return;
      onCloseRef.current();
    };
    const close = () => onCloseRef.current();
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("contextmenu", closeOutside, true);
    window.addEventListener("scroll", closeOnScroll, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("contextmenu", closeOutside, true);
      window.removeEventListener("scroll", closeOnScroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [anchor]);

  function action(callback: () => void) {
    onClose();
    callback();
  }
  return createPortal(
    <div
      ref={menu}
      role="menu"
      aria-label={`Actions for ${targetName}`}
      className="project-context-menu"
      style={position}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault();
          onClose();
          anchor.trigger.focus({ preventScroll: true });
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        const items = Array.from(
          menu.current!.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ),
        );
        const current = items.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (current +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  items.length) %
                items.length;
        items[next]?.focus({ preventScroll: true });
      }}
    >
      <div
        className="context-project-name"
        title={anchor.folderPath || project.path}
      >
        {targetName}
      </div>
      {nestedFolder && (
        <>
          <div className="context-folder-path" title={anchor.folderPath}>
            {anchor.folderPath}
          </div>
          {onOpenFolder && (
            <button
              role="menuitem"
              disabled={!project.available}
              onClick={() => action(onOpenFolder)}
            >
              <FolderOpen size={14} />
              Open folder
            </button>
          )}
          {onCopyPath && (
            <button role="menuitem" onClick={() => action(onCopyPath)}>
              <Copy size={14} />
              Copy full path
            </button>
          )}
          <div role="separator" className="dropdown-divider" />
          <div className="launcher-menu-label" title={projectName(project)}>
            Project: {projectName(project)}
          </div>
        </>
      )}
      <button role="menuitem" onClick={() => action(onRename)}>
        <Pencil size={14} />
        {nestedFolder
          ? "Rename project display label…"
          : "Rename display label…"}
      </button>
      <button
        role="menuitem"
        aria-expanded={colorsOpen}
        onClick={() => setColorsOpen((value) => !value)}
      >
        <Palette size={14} />
        {nestedFolder ? "Project folder colour" : "Folder colour"}
      </button>
      {colorsOpen && (
        <div
          role="group"
          aria-label="Folder colours"
          className="context-colors"
        >
          {projectColors.map((color) => (
            <button
              key={color}
              role="menuitemradio"
              aria-checked={project.color === color}
              aria-label={`Colour ${color}`}
              style={{ background: color }}
              onClick={() => action(() => onColor(color))}
            >
              {project.color === color && <Check size={12} />}
            </button>
          ))}
        </div>
      )}
      <div role="separator" className="dropdown-divider" />
      {nestedFolder && (
        <div className="launcher-menu-label">Selected folder</div>
      )}
      <button
        role="menuitem"
        disabled={!project.available}
        onClick={() => action(() => onLaunch("explorer"))}
      >
        <FolderOpen size={14} />
        Open in Explorer
      </button>
      <button
        role="menuitem"
        disabled={!project.available}
        onClick={() => action(() => onLaunch("cmd"))}
      >
        <Terminal size={14} />
        Start CMD here
      </button>
      <button
        role="menuitem"
        disabled={!project.available}
        onClick={() => action(() => onLaunch("powershell"))}
      >
        <Terminal size={14} />
        Open PowerShell
      </button>
      {enabledLaunchers(settings).length > 0 && (
        <div className="launcher-menu-label">Supported tools</div>
      )}
      {enabledLaunchers(settings).map((tool) => (
        <button
          key={tool.id}
          role="menuitem"
          disabled={!project.available}
          onClick={() => action(() => onLaunch(tool.id))}
        >
          <img className="launcher-logo" src={tool.logo} alt="" />
          Start {tool.name} here
        </button>
      ))}
      {settings.tools.length > 0 && (
        <div className="launcher-menu-label">Custom tools</div>
      )}
      {settings.tools.map((tool) => (
        <button
          key={tool.id}
          role="menuitem"
          disabled={!project.available}
          onClick={() => action(() => onLaunch(tool.id))}
        >
          <ExternalLink size={14} />
          {tool.name}
        </button>
      ))}
      <div role="separator" className="dropdown-divider" />
      {nestedFolder && (
        <div className="launcher-menu-label" title={projectName(project)}>
          Project: {projectName(project)}
        </div>
      )}
      <button role="menuitem" onClick={() => action(onEdit)}>
        <Settings2 size={14} />
        {nestedFolder ? "Edit project details…" : "Edit details…"}
      </button>
      <button role="menuitem" onClick={() => action(onPin)}>
        <Pin size={14} />
        {project.pinned ? "Unpin project" : "Pin project"}
      </button>
      <button role="menuitem" onClick={() => action(onHide)}>
        {project.hidden ? <Eye size={14} /> : <EyeOff size={14} />}
        {project.hidden ? "Show project" : "Hide project"}
      </button>
    </div>,
    document.body,
  );
}
