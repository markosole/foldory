import { useState, type ReactNode } from "react";

export default function SettingsPreview({
  title,
  children,
}: {
  title: string;
  children: () => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="settings-markdown-preview"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{title}</summary>
      {open && children()}
    </details>
  );
}
