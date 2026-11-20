import { useMemo } from "react";
import { Sparkles } from "lucide-react";
import helpHtml from "../content/help.html?raw";

export default function HelpPage({
  onRunOnboarding,
}: {
  onRunOnboarding?: () => void;
}) {
  const { content, styles } = useMemo(() => {
    // Trusted, bundled HTML is shared with the standalone offline help page.
    const doc = new DOMParser().parseFromString(helpHtml, "text/html");
    return {
      content: doc.getElementById("project-manager-help")?.innerHTML || "",
      styles: doc.querySelector("style")?.textContent || "",
    };
  }, []);
  return (
    <div className="settings-help-page">
      <div className="settings-help-actions">
        <span>HOW TO &amp; HELP</span>
        {onRunOnboarding && (
          <button className="button primary" onClick={onRunOnboarding}>
            <Sparkles size={15} />
            Run onboarding
          </button>
        )}
      </div>
      <style>{styles}</style>
      <article
        id="project-manager-help"
        onClick={(event) => {
          const anchor = (event.target as HTMLElement).closest("a");
          const href = anchor?.getAttribute("href");
          if (href?.startsWith("#")) {
            event.preventDefault();
            const target = event.currentTarget.querySelector<HTMLElement>(href);
            target?.scrollIntoView({ block: "start" });
            target?.setAttribute("tabindex", "-1");
            target?.focus({ preventScroll: true });
          }
        }}
        dangerouslySetInnerHTML={{ __html: content }}
      />
    </div>
  );
}
