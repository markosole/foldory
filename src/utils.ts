import type { Project } from "./types";
export const projectColors = [
  "#83a9ff",
  "#b69af4",
  "#6ec9a8",
  "#e5ba75",
  "#ee9494",
  "#d49adf",
  "#8fabb9",
  "#d1d4d8",
];
export function projectName(project: Project) {
  return project.alias.trim() || project.name;
}
export function matchesProject(project: Project, query: string) {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const value = [
    project.alias,
    project.name,
    project.client,
    project.path,
    ...project.tags,
  ]
    .join(" ")
    .toLocaleLowerCase();
  return terms.every((term) => value.includes(term));
}
export function relativeTime(time: number) {
  if (!time) return "Not opened";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(time).toLocaleDateString();
}
export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export function validateProjectName(name: string) {
  if (!name.trim()) return "Enter a project name.";
  if (name !== name.trim()) return "Remove spaces at the beginning or end.";
  if (name.length > 100) return "Use 100 characters or fewer.";
  if (
    /[<>:"/\\|?*\x00-\x1f]/.test(name) ||
    /[. ]$/.test(name) ||
    name === "." ||
    name === ".."
  )
    return "Use a valid Windows folder name, without slashes or trailing dots.";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
    return "That name is reserved by Windows.";
  return "";
}
