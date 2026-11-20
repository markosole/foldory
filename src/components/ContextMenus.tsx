import {
  Fragment,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import "./project-context-menu.css";

export interface MenuAction {
  label: string;
  run: () => void | Promise<unknown>;
  disabled?: boolean;
  shortcut?: string;
  icon?: ReactNode;
  section?: string;
}
interface MenuState {
  x: number;
  y: number;
  trigger: HTMLElement;
  label: string;
  actions: MenuAction[];
}
const MenuContext = createContext<
  (event: MouseEvent<HTMLElement>, label: string, actions: MenuAction[]) => void
>(() => {});
export const useContextMenu = () => useContext(MenuContext);

// Keep this selector aligned with the selectable content rules in styles.css.
const readableSelector =
  ".markdown, .chat-user-text, .inspector-rendered, .selectable, .git-change, .commit-row, [role='alert'], .inline-error, .editor-notice, .explorer-message.error";

export default function ContextMenus({
  children,
  actions,
  onError,
}: {
  children: ReactNode;
  actions: MenuAction[];
  onError: (message: string) => void;
}) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const defaults = useRef(actions);
  defaults.current = actions;
  useEffect(() => {
    const handler = (event: globalThis.MouseEvent) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest('[role="menu"]')) return;
      const input = target.closest<HTMLInputElement | HTMLTextAreaElement>(
        "input, textarea",
      );
      const textInput =
        input &&
        (input instanceof HTMLTextAreaElement ||
          [
            "text",
            "search",
            "url",
            "email",
            "tel",
            "password",
            "number",
          ].includes(input.type))
          ? input
          : null;
      const readable = target.closest<HTMLElement>(readableSelector);
      const selection = window.getSelection();
      const selected =
        readable &&
        selection?.anchorNode &&
        readable.contains(selection.anchorNode)
          ? selection.toString()
          : "";
      const start = textInput?.selectionStart ?? 0;
      const end = textInput?.selectionEnd ?? 0;
      const restore = () => {
        textInput?.focus({ preventScroll: true });
        if (textInput?.selectionStart !== null)
          textInput?.setSelectionRange(start, end);
      };
      const inputSelected = textInput?.value.slice(start, end) ?? "";
      const secret =
        textInput instanceof HTMLInputElement && textInput.type === "password";
      const replace = (text: string) => {
        restore();
        // Native editing preserves the browser undo stack and React input events.
        if (!document.execCommand("insertText", false, text))
          throw new Error(
            "Unable to insert text. Use the keyboard paste shortcut.",
          );
      };
      const items: MenuAction[] = textInput
        ? [
            {
              label: "Undo",
              shortcut: "Ctrl+Z",
              disabled: textInput.readOnly || textInput.disabled,
              run: () => {
                restore();
                document.execCommand("undo");
              },
            },
            {
              label: "Redo",
              shortcut: "Ctrl+Y",
              disabled: textInput.readOnly || textInput.disabled,
              run: () => {
                restore();
                document.execCommand("redo");
              },
            },
            {
              label: "Cut",
              shortcut: "Ctrl+X",
              disabled:
                secret ||
                !inputSelected ||
                textInput.readOnly ||
                textInput.disabled,
              run: async () => {
                await navigator.clipboard.writeText(inputSelected);
                replace("");
              },
            },
            {
              label: "Copy",
              shortcut: "Ctrl+C",
              disabled: secret || !inputSelected,
              run: () => navigator.clipboard.writeText(inputSelected),
            },
            {
              label: "Paste",
              shortcut: "Ctrl+V",
              disabled: textInput.readOnly || textInput.disabled,
              run: async () => replace(await navigator.clipboard.readText()),
            },
            {
              label: "Select all",
              shortcut: "Ctrl+A",
              disabled: textInput.disabled,
              run: () => {
                textInput.focus();
                textInput.select();
              },
            },
          ]
        : readable
          ? [
              {
                label: "Copy",
                shortcut: "Ctrl+C",
                disabled: !selected,
                run: () => navigator.clipboard.writeText(selected),
              },
              {
                label: "Select all",
                shortcut: "Ctrl+A",
                run: () => {
                  const range = document.createRange();
                  range.selectNodeContents(readable);
                  selection?.removeAllRanges();
                  selection?.addRange(range);
                },
              },
            ]
          : [...defaults.current];
      const link = target.closest<HTMLAnchorElement>("a[href]");
      if (link)
        items.push({
          label: "Copy link address",
          run: () => navigator.clipboard.writeText(link.href),
        });
      const trigger = (textInput || readable || target) as HTMLElement;
      const rect = trigger.getBoundingClientRect();
      setMenu({
        x: event.clientX || rect.left,
        y: event.clientY || rect.bottom,
        trigger,
        label: textInput
          ? "Text actions"
          : readable
            ? "Document actions"
            : "Workspace actions",
        actions: [...items],
      });
    };
    // Bubble after React handlers so specialized menus can claim the event.
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, []);
  return (
    <MenuContext.Provider
      value={(event, label, items) => {
        event.preventDefault();
        event.stopPropagation();
        const trigger = event.currentTarget;
        const rect = trigger.getBoundingClientRect();
        setMenu({
          x: event.clientX || rect.left,
          y: event.clientY || rect.bottom,
          trigger,
          label,
          actions: items,
        });
      }}
    >
      {children}
      {menu && (
        <ActionMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onError={onError}
        />
      )}
    </MenuContext.Provider>
  );
}

function ActionMenu({
  menu,
  onClose,
  onError,
}: {
  menu: MenuState;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const box = ref.current!.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(menu.x, innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(menu.y, innerHeight - box.height - 8)),
    });
    ref.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus({ preventScroll: true });
    const outside = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) closeRef.current();
    };
    const close = () => closeRef.current();
    window.addEventListener("pointerdown", outside);
    window.addEventListener("contextmenu", outside, true);
    window.addEventListener("scroll", outside, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("contextmenu", outside, true);
      window.removeEventListener("scroll", outside, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);
  return createPortal(
    <div
      ref={ref}
      className="project-context-menu"
      role="menu"
      aria-label={menu.label}
      style={position}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (["Escape", "Tab"].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          menu.trigger.focus({ preventScroll: true });
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        const items = Array.from(
          ref.current!.querySelectorAll<HTMLButtonElement>(
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
      <div className="context-project-name">{menu.label}</div>
      {menu.actions.map((item) => (
        <Fragment key={item.label}>
          {item.section && (
            <div className="launcher-menu-label">{item.section}</div>
          )}
          <button
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              menu.trigger.focus({ preventScroll: true });
              try {
                Promise.resolve(item.run()).catch((error) =>
                  onError(String(error)),
                );
              } catch (error) {
                onError(String(error));
              }
            }}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.shortcut && (
              <span className="context-shortcut">{item.shortcut}</span>
            )}
          </button>
        </Fragment>
      ))}
    </div>,
    menu.trigger.closest("dialog[open]") ?? document.body,
  );
}
