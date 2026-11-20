import { useCallback, useEffect, useRef, useState } from "react";
import { Shield, ShieldAlert, ShieldCheck } from "lucide-react";
import { api, desktop } from "../api";
import type { AssistantAccessMode } from "../types";
import AppSelect, { type SelectOption } from "./AppSelect";

const modes: {
  value: AssistantAccessMode;
  label: string;
  description: string;
}[] = [
  {
    value: "readOnly",
    label: "Read only access",
    description:
      "Read project sources. Each proposed file change needs your approval.",
  },
  {
    value: "write",
    label: "Allow write access",
    description:
      "Save ordinary project files automatically. Protected or excluded files still need approval.",
  },
  {
    value: "full",
    label: "Full access",
    description:
      "Read and save files in this project, including excluded sources, without asking. No shell commands or access outside the project.",
  },
];

function AccessShield({ mode }: { mode: AssistantAccessMode }) {
  const Icon =
    mode === "readOnly" ? ShieldCheck : mode === "write" ? Shield : ShieldAlert;
  return (
    <Icon
      size={15}
      className={`assistant-access-shield access-${mode}`}
      aria-hidden="true"
    />
  );
}

export function useAssistantAccess(projectId?: string) {
  const [mode, setMode] = useState<AssistantAccessMode>("readOnly");
  const [loaded, setLoaded] = useState(!projectId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const mounted = useRef(false);
  const request = useRef(0);
  const inProgress = useRef(false);

  const load = useCallback(async () => {
    if (!projectId || !desktop) return;
    const id = ++request.current;
    setLoaded(false);
    setError(null);
    try {
      const result = await api.getAssistantAccess(projectId);
      if (mounted.current && request.current === id) {
        setMode(result.mode);
        setLoaded(true);
      }
    } catch (cause) {
      if (mounted.current && request.current === id) {
        setMode("readOnly");
        setError(cause);
      }
    }
  }, [projectId]);

  useEffect(() => {
    mounted.current = true;
    setMode("readOnly");
    setLoaded(!projectId);
    void load();
    return () => {
      mounted.current = false;
      request.current += 1;
    };
  }, [projectId, load]);

  async function change(next: AssistantAccessMode) {
    if (!projectId || !loaded || inProgress.current || next === mode) return;
    const id = ++request.current;
    inProgress.current = true;
    setSaving(true);
    setLoaded(false);
    setError(null);
    try {
      await api.setAssistantAccess(projectId, next);
      const actual = await api.getAssistantAccess(projectId);
      if (mounted.current && request.current === id) {
        setMode(actual.mode);
        setLoaded(true);
      }
    } catch (cause) {
      if (mounted.current && request.current === id) {
        setMode("readOnly");
        setError(cause);
      }
    } finally {
      inProgress.current = false;
      if (mounted.current && request.current === id) setSaving(false);
    }
  }

  return { mode, loaded, saving, error, load, change };
}

export default function AssistantAccessPicker({
  access,
  disabled,
}: {
  access: ReturnType<typeof useAssistantAccess>;
  disabled: boolean;
}) {
  const options: SelectOption[] = modes.map((mode) => ({
    ...mode,
    icon: <AccessShield mode={mode.value} />,
  }));
  const selected = modes.find((item) => item.value === access.mode)!;
  return (
    <div className="assistant-access-picker">
      <AppSelect
        value={access.mode}
        onChange={(value) => void access.change(value as AssistantAccessMode)}
        options={options}
        aria-label="Assistant access"
        title={
          !access.loaded
            ? "Checking project access. Requests remain disabled until access is verified."
            : selected.description
        }
        compact
        searchable={false}
        icon={<AccessShield mode={access.mode} />}
        disabled={disabled || !desktop || !access.loaded || access.saving}
      />
    </div>
  );
}
