export interface IntegrationField {
  key: string;
  label: string;
  kind: "file" | "text";
  defaultValue: string;
  help: string;
  extensions: string[];
}
export interface IntegrationManifest {
  id: string;
  name: string;
  description: string;
  configVersion: number;
  capabilities: string[];
  permissions: string[];
  fields: IntegrationField[];
}
export interface Integration {
  id: string;
  providerId: string;
  name: string;
  enabled: boolean;
  configVersion: number;
  config: Record<string, string>;
}
export interface IntegrationProject {
  id: string;
  name: string;
  path: string;
  color: string;
  pathStatus:
    "available" | "missing" | "not-directory" | "unavailable" | "invalid";
  pathMessage: string;
}
export interface IntegrationGroup {
  id: string;
  name: string;
  projects: IntegrationProject[];
}
export interface IntegrationWorkspaceData {
  groups: IntegrationGroup[];
  warnings: string[];
  checkedAt: number;
}
