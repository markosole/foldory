import { useState } from "react";
import {
  Check,
  FilePlus2,
  FileText,
  Folder,
  Plus,
  Shield,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { Template } from "../types";

type TreeNode = {
  path: string;
  name: string;
  directory: boolean;
  children: TreeNode[];
};

export function templateTree(template: Template): TreeNode[] {
  const root: TreeNode = { path: "", name: "", directory: true, children: [] };
  const add = (raw: string, directory: boolean) => {
    const parts = raw.replace(/\\/g, "/").split("/").filter(Boolean);
    let parent = root;
    parts.forEach((name, index) => {
      const path = parent.path ? `${parent.path}/${name}` : name;
      let node = parent.children.find(
        (child) => child.name.toLowerCase() === name.toLowerCase(),
      );
      if (!node) {
        node = {
          path,
          name,
          directory: index < parts.length - 1 || directory,
          children: [],
        };
        parent.children.push(node);
      }
      parent = node;
    });
  };
  template.directories.forEach((path) => add(path, true));
  template.files.forEach(({ path }) => add(path, false));
  const sort = (nodes: TreeNode[]) => {
    nodes.sort(
      (a, b) =>
        Number(b.directory) - Number(a.directory) ||
        a.name.localeCompare(b.name),
    );
    nodes.forEach((node) => sort(node.children));
  };
  sort(root.children);
  return root.children;
}

export function secureTemplatePath(template: Template, path: string): Template {
  if (path.toLowerCase() === "secure") return template;
  template = {
    ...template,
    directories: template.directories.map((value) =>
      value.trim().replace(/\\/g, "/"),
    ),
    files: template.files.map((file) => ({
      ...file,
      path: file.path.trim().replace(/\\/g, "/"),
    })),
  };
  const parts = path.split("/");
  const secureIndex = parts.findIndex(
    (part) => part.toLowerCase() === "secure",
  );
  const nextPath =
    secureIndex < 0
      ? `Secure/${path}`
      : parts.filter((_, index) => index !== secureIndex).join("/");
  const rewrite = (value: string) =>
    value.toLowerCase() === path.toLowerCase() ||
    value.toLowerCase().startsWith(`${path.toLowerCase()}/`)
      ? `${nextPath}${value.slice(path.length)}`
      : value;
  const directories = [...new Set(template.directories.map(rewrite))];
  const files = template.files.map((file) => ({
    ...file,
    path: rewrite(file.path),
  }));
  const names = [
    ...directories,
    ...files.map(({ path: filePath }) => filePath),
  ].map((value) => value.toLowerCase());
  // Moving a folder must not silently merge it with an existing destination.
  const unchanged = [
    ...template.directories,
    ...template.files.map(({ path: filePath }) => filePath),
  ].filter((value) => value !== path && !value.startsWith(`${path}/`));
  if (
    new Set(names).size !== names.length ||
    unchanged.some(
      (value) =>
        value.toLowerCase() === nextPath.toLowerCase() ||
        value.toLowerCase().startsWith(`${nextPath.toLowerCase()}/`),
    )
  )
    throw new Error(
      `A file or folder already exists at ${nextPath}. Rename it before changing protection.`,
    );
  return { ...template, directories, files };
}

function Tree({
  nodes,
  editable,
  onSecure,
}: {
  nodes: TreeNode[];
  editable: boolean;
  onSecure: (path: string) => void;
}) {
  return (
    <ul>
      {nodes.map((node) => {
        const secure = node.path
          .split("/")
          .some((part) => part.toLowerCase() === "secure");
        return (
          <li key={node.path}>
            <div className={secure ? "secured" : ""}>
              {node.directory ? <Folder size={15} /> : <FileText size={15} />}
              <span title={node.path}>{node.name}</span>
              {editable && node.name.toLowerCase() !== "secure" ? (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`${secure ? "Unsecure" : "Secure"} ${node.path}`}
                  title={secure ? "Move out of Secure" : "Move into Secure"}
                  onClick={() => onSecure(node.path)}
                >
                  {secure ? <ShieldCheck size={14} /> : <Shield size={14} />}
                </button>
              ) : (
                secure && <ShieldCheck size={13} />
              )}
            </div>
            {node.children.length > 0 && (
              <Tree
                nodes={node.children}
                editable={editable}
                onSecure={onSecure}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

export default function TemplateBuilder({
  template,
  editing,
  onChange,
  onEdit,
}: {
  template?: Template;
  editing: boolean;
  onChange: (template: Template) => void;
  onEdit: (template: Template) => void;
}) {
  const [stage, setStage] = useState(0);
  const [error, setError] = useState("");
  if (!template) return null;
  const change = (patch: Partial<Template>) => {
    setError("");
    onChange({ ...template, ...patch });
  };
  return (
    <div className="onboarding-template-builder">
      <div className="onboarding-builder-header">
        <strong>{editing ? "Template builder" : "Starting structure"}</strong>
        {!editing && (
          <button
            type="button"
            className="text-button"
            onClick={() => onEdit(template)}
          >
            Customize template
          </button>
        )}
      </div>
      {editing && (
        <nav
          className="onboarding-builder-stages"
          aria-label="Template creation steps"
        >
          {["Name", "Folders & files", "Protect"].map((name, index) => (
            <button
              key={name}
              type="button"
              aria-current={stage === index ? "step" : undefined}
              className={stage === index ? "active" : ""}
              onClick={() => setStage(index)}
            >
              <span>{index < stage ? <Check size={12} /> : index + 1}</span>
              {name}
            </button>
          ))}
        </nav>
      )}
      <div
        className={`onboarding-builder-columns${editing ? "" : " preview-only"}`}
      >
        {editing && (
          <div className="onboarding-builder-fields">
            {stage === 0 && (
              <>
                <label className="field">
                  Template name
                  <input
                    value={template.name}
                    maxLength={200}
                    required
                    onChange={(event) => change({ name: event.target.value })}
                    placeholder="e.g. Client website"
                  />
                </label>
                <p className="settings-help">
                  Choose a name you’ll recognize when creating a project.
                  Starter files can use {"{{name}}"} and {"{{client}}"}; the app
                  fills them in for each new project.
                </p>
                <button
                  type="button"
                  className="button"
                  onClick={() => setStage(1)}
                >
                  Add folders & files
                  <Plus size={14} />
                </button>
              </>
            )}
            {stage === 1 && (
              <>
                <label className="field">
                  Folders
                  <textarea
                    rows={5}
                    value={template.directories.join("\n")}
                    onChange={(event) =>
                      change({ directories: event.target.value.split("\n") })
                    }
                    placeholder={"Docs\nApp\nDesign/Assets"}
                  />
                </label>
                <p className="settings-help">
                  One relative folder per line. Use / to nest folders. The
                  preview updates as you type.
                </p>
                <div className="onboarding-section-label">
                  <strong>Starter files</strong>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      change({
                        files: [
                          ...template.files,
                          {
                            path: `notes${template.files.length || ""}.md`,
                            content: "",
                          },
                        ],
                      })
                    }
                  >
                    <FilePlus2 size={14} />
                    Add file
                  </button>
                </div>
                {template.files.map((file, index) => (
                  <div key={index} className="onboarding-starter-file">
                    <label className="field">
                      File path
                      <input
                        aria-label={`Starter file ${index + 1} path`}
                        value={file.path}
                        onChange={(event) =>
                          change({
                            files: template.files.map((item, i) =>
                              i === index
                                ? { ...item, path: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Remove starter file ${index + 1}`}
                      onClick={() =>
                        change({
                          files: template.files.filter((_, i) => i !== index),
                        })
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                    <label className="field">
                      Contents
                      <textarea
                        aria-label={`Starter file ${index + 1} contents`}
                        rows={3}
                        value={file.content}
                        onChange={(event) =>
                          change({
                            files: template.files.map((item, i) =>
                              i === index
                                ? { ...item, content: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                    </label>
                  </div>
                ))}
                <button
                  type="button"
                  className="button"
                  onClick={() => setStage(2)}
                >
                  <ShieldCheck size={14} />
                  Choose protected items
                </button>
              </>
            )}
            {stage === 2 && (
              <div className="onboarding-protect-copy">
                <ShieldCheck size={28} />
                <h3>Click a shield. Keep it private.</h3>
                <p>
                  Click <Shield size={14} /> beside any file or folder in the
                  tree to move it under <strong>Secure/</strong>. Click it again
                  to move it out.
                </p>
                <p>
                  Files inside Secure are excluded from the app’s content index,
                  inspector and AI context by default. Approval is required for
                  explicit AI inclusion.
                </p>
                <p className="settings-help">
                  This is an app privacy convention, not encryption or a lock on
                  disk. External tools and provider CLIs follow their own access
                  rules.
                </p>
              </div>
            )}
          </div>
        )}
        <div className="onboarding-tree">
          <div className="eyebrow">
            LIVE PREVIEW <span>new-project/</span>
          </div>
          <div className="onboarding-tree-root">
            <Folder size={16} />
            My next project
          </div>
          <Tree
            nodes={templateTree(template)}
            editable={editing}
            onSecure={(path) => {
              try {
                setError("");
                onChange(secureTemplatePath(template, path));
              } catch (error) {
                setError(
                  error instanceof Error ? error.message : String(error),
                );
              }
            }}
          />
          {!template.directories.some(Boolean) && !template.files.length && (
            <p className="settings-help">
              Add a folder or file to see it here.
            </p>
          )}
        </div>
      </div>
      {error && (
        <p className="onboarding-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
