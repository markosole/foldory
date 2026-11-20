import { useId, useMemo, type ReactNode } from "react";
import { ChevronDown, ChevronRight, HardDrive } from "lucide-react";
import type { Project, Source } from "../types";
import { useStoredBoolean } from "../useStoredState";

function SourceGroup({
  source,
  projects,
  renderProject,
}: {
  source: Source;
  projects: Project[];
  renderProject: (project: Project) => ReactNode;
}) {
  const [folded, setFolded] = useStoredBoolean(
    `foldory.source-folded.${source.id}`,
  );
  const listId = useId();
  return (
    <li className="sidebar-source-group">
      <button
        className="sidebar-source-toggle"
        aria-expanded={!folded}
        aria-controls={listId}
        title={`${source.name}\n${source.path}${source.available ? "" : "\nSource offline"}`}
        onClick={() => setFolded(!folded)}
      >
        {folded ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <HardDrive size={15} className="sidebar-source-icon" />
        <span className="sidebar-source-details">
          <span className="sidebar-source-name">{source.name}</span>
          <span className="sidebar-source-path">{source.path}</span>
        </span>
        {!source.available && (
          <span className="sidebar-source-offline" title="Source offline">
            Offline
          </span>
        )}
        <span
          className="sidebar-source-count"
          aria-label={`${projects.length} ${projects.length === 1 ? "project" : "projects"}`}
        >
          {projects.length}
        </span>
      </button>
      <div id={listId} hidden={folded} className="sidebar-source-children">
        {!folded &&
          (projects.length ? (
            <ul>
              {projects.map((project) => (
                <li key={project.id}>{renderProject(project)}</li>
              ))}
            </ul>
          ) : (
            <p className="sidebar-hint">No visible projects.</p>
          ))}
      </div>
    </li>
  );
}

export default function SidebarProjectSources({
  sources,
  projects,
  renderProject,
}: {
  sources: Source[];
  projects: Project[];
  renderProject: (project: Project) => ReactNode;
}) {
  const bySource = useMemo(() => {
    const groups = new Map<string, Project[]>();
    for (const project of projects) {
      const group = groups.get(project.sourceId) ?? [];
      group.push(project);
      groups.set(project.sourceId, group);
    }
    return groups;
  }, [projects]);

  return (
    <ul className="sidebar-source-list" aria-label="Project sources">
      {sources.map((source) => (
        <SourceGroup
          key={source.id}
          source={source}
          projects={bySource.get(source.id) ?? []}
          renderProject={renderProject}
        />
      ))}
    </ul>
  );
}
