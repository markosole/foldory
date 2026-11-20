import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";
import "./app-select.css";

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
  group?: string;
  keywords?: string;
  icon?: ReactNode;
  description?: string;
};

type Props = {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  disabled?: boolean;
  required?: boolean;
  searchable?: boolean;
  placeholder?: string;
  className?: string;
  title?: string;
  compact?: boolean;
  icon?: ReactNode;
};

/** A select-only combobox. Searching never changes the committed value. */
export default function AppSelect({
  value,
  onChange,
  options,
  id,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
  disabled = false,
  required = false,
  searchable = options.length >= 8,
  placeholder = "Choose an option",
  className = "",
  title,
  compact = false,
  icon,
}: Props) {
  const generatedId = useId();
  const triggerId = id || generatedId;
  const listId = `${generatedId}-options`;
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [accessibleName, setAccessibleName] = useState(ariaLabel || "Options");
  const [position, setPosition] = useState<CSSProperties>({
    left: 0,
    top: 0,
    width: 320,
    maxHeight: 320,
  });
  const typeahead = useRef({ text: "", time: 0 });
  const selected = options.find((option) => option.value === value);
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return options.filter(
      (option) =>
        !term ||
        `${option.label} ${option.description || ""} ${option.group || ""} ${option.keywords || ""}`
          .toLocaleLowerCase()
          .includes(term),
    );
  }, [options, query]);
  const enabled = filtered.filter((option) => !option.disabled);
  const currentActive =
    enabled.find((option) => option.value === active) ?? enabled[0];
  const activeIndex = currentActive ? filtered.indexOf(currentActive) : -1;
  const activeId =
    open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined;
  const groups = new Map<string, SelectOption[]>();
  for (const option of filtered) {
    const group = option.group || "";
    groups.set(group, [...(groups.get(group) || []), option]);
  }

  function close(restoreFocus = false) {
    setOpen(false);
    setQuery("");
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }

  function show(initialQuery = "", last = false) {
    if (disabled || trigger.current?.matches(":disabled")) return;
    const label =
      ariaLabel ||
      (labelledBy && document.getElementById(labelledBy)?.textContent) ||
      trigger.current?.labels?.[0]?.textContent
        ?.replace(selected?.label || "", "")
        .trim() ||
      "Options";
    setAccessibleName(label);
    setQuery(initialQuery);
    const available = options.filter((option) => !option.disabled);
    setActive(
      selected && !selected.disabled
        ? value
        : ((last ? available.at(-1) : available[0])?.value ?? null),
    );
    setOpen(true);
  }

  function choose(option: SelectOption) {
    if (disabled || trigger.current?.matches(":disabled") || option.disabled)
      return;
    onChange(option.value);
    close(true);
  }

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = trigger.current!;
    const rect = anchor.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 14;
    const above = rect.top - 14;
    // The list scrolls independently: measure its full content, not the popup's
    // previously constrained height, so clearing a search can expand it again.
    const menu = popup.current!;
    const content = list.current!;
    const naturalHeight =
      menu.scrollHeight -
      content.clientHeight +
      content.scrollHeight +
      menu.offsetHeight -
      menu.clientHeight;
    const desired = Math.min(320, naturalHeight || 320);
    const upwards = below < desired && above > below;
    const height = Math.max(0, Math.min(desired, upwards ? above : below));
    const width = Math.min(
      Math.max(
        rect.width,
        options.some((option) => option.description)
          ? 360
          : searchable
            ? 260
            : 200,
      ),
      window.innerWidth - 16,
    );
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: upwards ? undefined : Math.max(8, rect.bottom + 6),
      bottom: upwards
        ? Math.max(8, window.innerHeight - rect.top + 6)
        : undefined,
      width,
      maxHeight: height,
    });
  }, [open, filtered, searchable]);

  useLayoutEffect(() => {
    if (!open) return;
    if (searchable) search.current?.focus({ preventScroll: true });
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (
        !popup.current?.contains(target) &&
        !trigger.current?.contains(target)
      )
        close();
    };
    const anchor = trigger.current!.getBoundingClientRect();
    const onScroll = (event: Event) => {
      if (popup.current?.contains(event.target as Node)) return;
      const now = trigger.current?.getBoundingClientRect();
      if (now?.top !== anchor.top || now?.left !== anchor.left) close();
    };
    const dismiss = () => close();
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [open, searchable]);

  useLayoutEffect(() => {
    if (!open || !activeId || !list.current) return;
    const option = document.getElementById(activeId);
    if (!option) return;
    const bounds = list.current.getBoundingClientRect();
    const row = option.getBoundingClientRect();
    if (row.top < bounds.top) list.current.scrollTop -= bounds.top - row.top;
    else if (row.bottom > bounds.bottom)
      list.current.scrollTop += row.bottom - bounds.bottom;
  }, [open, activeId, filtered, position.maxHeight, position.width]);

  function handleKey(event: KeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab" && open) {
      // Resume the normal tab order from the original control, including in dialogs.
      close(true);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) show("", event.key === "ArrowUp");
      else {
        const index = enabled.indexOf(currentActive);
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setActive(
          enabled[(index + delta + enabled.length) % enabled.length]?.value ??
            null,
        );
      }
      return;
    }
    if (
      open &&
      (event.key === "Home" || event.key === "End") &&
      event.target !== search.current
    ) {
      event.preventDefault();
      setActive(
        (event.key === "Home" ? enabled[0] : enabled.at(-1))?.value ?? null,
      );
      return;
    }
    if (
      event.key === "Enter" ||
      (event.key === " " && event.target !== search.current)
    ) {
      event.preventDefault();
      if (!open) show();
      else if (currentActive) choose(currentActive);
      return;
    }
    if (
      event.target !== search.current &&
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      if (searchable) {
        show(event.key);
      } else {
        const now = Date.now();
        const term =
          `${now - typeahead.current.time < 700 ? typeahead.current.text : ""}${event.key}`.toLocaleLowerCase();
        typeahead.current = { text: term, time: now };
        if (!open) show();
        const match = options.find(
          (option) =>
            !option.disabled &&
            option.label.toLocaleLowerCase().startsWith(term),
        );
        if (match) setActive(match.value);
      }
    }
  }

  return (
    <div className={`app-select ${compact ? "compact" : ""} ${className}`}>
      <button
        ref={trigger}
        id={triggerId}
        type="button"
        className="app-select-trigger"
        role="combobox"
        aria-label={ariaLabel}
        aria-labelledby={labelledBy}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-haspopup="listbox"
        aria-activedescendant={!searchable ? activeId : undefined}
        aria-required={required || undefined}
        value={value}
        disabled={disabled}
        title={title || selected?.label}
        onClick={() => (open ? close(true) : show())}
        onKeyDown={handleKey}
      >
        {icon || (searchable && <Search size={14} aria-hidden="true" />)}
        <span className={selected ? "" : "app-select-placeholder"}>
          {selected?.label || placeholder}
        </span>
        <ChevronDown
          size={14}
          className="app-select-chevron"
          aria-hidden="true"
        />
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            className="app-select-popup"
            style={position}
            onKeyDown={handleKey}
            onContextMenu={(event) => event.preventDefault()}
          >
            {searchable && (
              <div className="app-select-search">
                <Search size={14} aria-hidden="true" />
                <input
                  ref={search}
                  type="search"
                  aria-label={`Search ${accessibleName} options`}
                  aria-controls={listId}
                  aria-activedescendant={activeId}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Search options…"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActive(null);
                  }}
                />
              </div>
            )}
            <div
              ref={list}
              id={listId}
              className="app-select-options"
              role="listbox"
              aria-label={accessibleName}
            >
              {Array.from(groups, ([group, items]) => (
                <div
                  key={group}
                  role={group ? "group" : "presentation"}
                  aria-label={group || undefined}
                >
                  {group && (
                    <div className="app-select-group" aria-hidden="true">
                      {group}
                    </div>
                  )}
                  {items.map((option) => (
                    <div
                      id={`${listId}-${filtered.indexOf(option)}`}
                      key={option.value}
                      role="option"
                      aria-label={option.label}
                      aria-describedby={
                        option.description
                          ? `${listId}-${filtered.indexOf(option)}-description`
                          : undefined
                      }
                      aria-selected={option.value === value}
                      aria-disabled={option.disabled || undefined}
                      className={`app-select-option ${currentActive === option ? "active" : ""}`}
                      title={option.description || option.label}
                      onPointerMove={() => {
                        if (!option.disabled) setActive(option.value);
                      }}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => choose(option)}
                    >
                      {option.icon && (
                        <span
                          className="app-select-option-icon"
                          aria-hidden="true"
                        >
                          {option.icon}
                        </span>
                      )}
                      <span
                        className={
                          option.description
                            ? "app-select-option-copy"
                            : undefined
                        }
                      >
                        {option.label}
                        {option.description && (
                          <small
                            id={`${listId}-${filtered.indexOf(option)}-description`}
                          >
                            {option.description}
                          </small>
                        )}
                      </span>
                      {option.value === value && (
                        <Check size={14} aria-hidden="true" />
                      )}
                    </div>
                  ))}
                </div>
              ))}
              {!filtered.length && (
                <p className="app-select-empty" role="status">
                  {options.length
                    ? "No matching options"
                    : "No options available"}
                </p>
              )}
            </div>
          </div>,
          trigger.current?.closest("dialog[open]") ?? document.body,
        )}
    </div>
  );
}
