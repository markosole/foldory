import { call } from "../api";
import type {
  Integration,
  IntegrationManifest,
  IntegrationWorkspaceData,
} from "./types";

export const integrationsApi = {
  catalog: () => call<IntegrationManifest[]>("integration_catalog"),
  list: () => call<Integration[]>("list_integrations"),
  save: (integration: Integration) =>
    call<Integration>("save_integration", { integration }),
  remove: (id: string) => call<void>("remove_integration", { id }),
  workspace: (id: string) =>
    call<IntegrationWorkspaceData>("integration_workspace", { id }),
  openProject: (id: string, projectId: string) =>
    call<void>("open_integration_project", { id, projectId }),
  chooseFile: (providerId: string, fieldKey: string) =>
    call<string | null>("choose_integration_file", { providerId, fieldKey }),
};
