use crate::{
    ai_cli,
    assistant_actions::{validate_proposals, WriteProposal},
    integrations,
    models::{EndpointProvider, Settings},
    work, NativeState,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::PathBuf,
    sync::Mutex,
};
use tauri::State;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Provider {
    #[default]
    Local,
    Unsloth,
    Ollama,
    Openai,
    Gemini,
    Openrouter,
    Deepseek,
    Groq,
    Mistral,
    Custom,
    Codex,
    Cursor,
    Claude,
}

impl Provider {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Local => "LM Studio",
            Self::Unsloth => "Unsloth",
            Self::Ollama => "Ollama",
            Self::Openai => "OpenAI",
            Self::Gemini => "Google Gemini",
            Self::Openrouter => "OpenRouter",
            Self::Deepseek => "DeepSeek",
            Self::Groq => "Groq",
            Self::Mistral => "Mistral",
            Self::Custom => "Custom",
            Self::Codex => "ChatGPT Codex",
            Self::Cursor => "Cursor",
            Self::Claude => "Claude Code",
        }
    }
}

impl Provider {
    fn endpoint(self) -> Option<EndpointProvider> {
        match self {
            Self::Local => Some(EndpointProvider::Local),
            Self::Unsloth => Some(EndpointProvider::Unsloth),
            Self::Ollama => Some(EndpointProvider::Ollama),
            Self::Openai => Some(EndpointProvider::Openai),
            Self::Gemini => Some(EndpointProvider::Gemini),
            Self::Openrouter => Some(EndpointProvider::Openrouter),
            Self::Deepseek => Some(EndpointProvider::Deepseek),
            Self::Groq => Some(EndpointProvider::Groq),
            Self::Mistral => Some(EndpointProvider::Mistral),
            Self::Custom => Some(EndpointProvider::Custom),
            Self::Codex | Self::Cursor | Self::Claude => None,
        }
    }
}

#[derive(Clone, Copy, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AiMode {
    Inspector,
    Assistant,
    GlobalAssistant,
    WordParser,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelChoice {
    pub provider: Provider,
    pub model: Option<String>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct AiPreferences {
    preferred_local_models: Vec<String>,
    preferred_models: BTreeMap<Provider, Vec<String>>,
    selections: BTreeMap<AiMode, ModelChoice>,
}

pub(crate) struct AiState {
    pub dir: PathBuf,
    preferences_lock: Mutex<()>,
}

impl AiState {
    pub(crate) fn word_settings(&self, settings: Settings) -> Result<Settings, String> {
        let request = self.request(settings, AiMode::WordParser)?;
        if request.target.is_some() {
            return Err("Visual Word parsing requires a vision model at an OpenAI-compatible endpoint. Choose a local or API provider in the Word parser.".into());
        }
        Ok(request.settings)
    }
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            preferences_lock: Mutex::new(()),
        }
    }

    fn read(&self) -> Result<AiPreferences, String> {
        match fs::read(self.dir.join("preferences.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| format!("Could not read AI preferences: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AiPreferences::default()),
            Err(e) => Err(format!("Could not open AI preferences: {e}")),
        }
    }

    fn preferences(&self) -> Result<AiPreferences, String> {
        let _lock = self.preferences_lock.lock().map_err(|e| e.to_string())?;
        self.read()
    }

    fn update(&self, change: impl FnOnce(&mut AiPreferences)) -> Result<AiPreferences, String> {
        let _lock = self.preferences_lock.lock().map_err(|e| e.to_string())?;
        let mut preferences = self.read()?;
        change(&mut preferences);
        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let mut file = tempfile::NamedTempFile::new_in(&self.dir).map_err(|e| e.to_string())?;
        serde_json::to_writer_pretty(file.as_file_mut(), &preferences)
            .map_err(|e| e.to_string())?;
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        file.persist(self.dir.join("preferences.json"))
            .map_err(|e| format!("Could not save AI preferences: {e}"))?;
        Ok(preferences)
    }

    pub fn request(&self, mut settings: Settings, mode: AiMode) -> Result<AiRequest, String> {
        let choice = self
            .preferences()?
            .selections
            .remove(&mode)
            .unwrap_or_default();
        let target = match choice.provider {
            provider if provider.endpoint().is_some() => {
                settings.normalize_ai_providers();
                let endpoint_provider = provider.endpoint().unwrap();
                let endpoint = settings
                    .endpoint(endpoint_provider)
                    .cloned()
                    .ok_or_else(|| format!("Configure {} in Settings first.", provider.label()))?;
                if !endpoint.enabled {
                    return Err(format!("Enable {} in Settings first.", provider.label()));
                }
                settings.ai_provider = endpoint_provider;
                settings.ai_base_url = endpoint.base_url;
                settings.ai_model = endpoint.model;
                if let Some(model) = choice.model {
                    settings.ai_model = model;
                }
                integrations::validate_ai_settings(&settings)?;
                None
            }
            provider => Some(ai_cli::Target::detect(provider, &self.dir, choice.model)?),
        };
        Ok(AiRequest { settings, target })
    }
}

pub(crate) struct AiRequest {
    settings: Settings,
    target: Option<ai_cli::Target>,
}

impl AiRequest {
    pub fn overview_preview(&self, messages: &[Value]) -> String {
        if self.target.is_some() {
            ai_cli::request_prompt(messages)
        } else {
            serde_json::json!(messages).to_string()
        }
    }

    pub fn overview_destination(&self) -> String {
        self.target.as_ref().map_or_else(
            || format!("{} · {}", self.settings.ai_base_url, self.settings.ai_model),
            ai_cli::Target::destination,
        )
    }

    pub fn overview_output_limit(&self) -> Option<u32> {
        self.target
            .is_none()
            .then_some(self.settings.inspector.output_tokens)
    }

    pub async fn chat_with_actions(
        self,
        messages: Vec<Value>,
        enable_actions: bool,
    ) -> Result<AssistantCompletion, String> {
        match self.target {
            Some(target) => {
                // Provider CLIs remain in their existing isolated, read-only mode.
                // Only this returned text protocol may propose a native action.
                let content = target
                    .complete(messages, std::time::Duration::from_secs(90))
                    .await?;
                assistant_completion(content, vec![], enable_actions)
            }
            None => {
                integrations::complete_ai_with_actions(self.settings, messages, enable_actions)
                    .await
            }
        }
    }

    pub async fn overview(
        self,
        messages: Vec<Value>,
    ) -> Result<String, integrations::CompletionError> {
        match self.target {
            Some(target) => target
                .complete(
                    messages,
                    std::time::Duration::from_secs(self.settings.inspector.timeout_minutes * 60),
                )
                .await
                .map_err(Into::into),
            None => integrations::complete_overview(self.settings, messages).await,
        }
    }
}

#[derive(Debug)]
pub(crate) struct AssistantCompletion {
    pub content: String,
    pub writes: Vec<WriteProposal>,
}

pub(crate) fn parse_write_proposal(value: &Value) -> Result<WriteProposal, String> {
    let object = value.as_object().ok_or("The AI returned invalid file-action arguments. Expected path and content strings; no file changes were applied.")?;
    if object.len() != 2 || !object.contains_key("path") || !object.contains_key("content") {
        return Err("The AI returned unsupported file-action arguments. Only path and content are accepted; no file changes were applied.".into());
    }
    let path = object["path"].as_str().ok_or(
        "The AI returned a file action without a valid path string; no file changes were applied.",
    )?;
    let content = object["content"].as_str().ok_or("The AI returned a file action without a valid content string; no file changes were applied.")?;
    Ok(WriteProposal {
        path: path.into(),
        content: content.into(),
    })
}

/// Parse only an explicit top-level protocol fence in an assistant response.
/// Examples nested in ordinary Markdown fences or block quotes are inert.
fn text_action_block(
    content: &str,
    enable_actions: bool,
) -> Result<(String, Vec<WriteProposal>), String> {
    fn fence(line: &str) -> Option<(char, usize, &str)> {
        let line = line.trim_end_matches(['\r', '\n']);
        let indentation = line.bytes().take_while(|byte| *byte == b' ').count();
        if indentation > 3 {
            return None;
        }
        let line = &line[indentation..];
        let marker = line.chars().next()?;
        if marker != '`' && marker != '~' {
            return None;
        }
        let length = line.chars().take_while(|ch| *ch == marker).count();
        (length >= 3).then_some((marker, length, &line[length..]))
    }

    let mut ordinary_fence = None;
    let mut action_start = None;
    let mut action_body = 0;
    let mut action_end = None;
    let mut writes = vec![];
    let mut offset = 0;
    for line in content.split_inclusive('\n') {
        let line_start = offset;
        offset += line.len();
        let Some((marker, length, info)) = fence(line) else {
            continue;
        };
        if let Some((open_marker, open_length)) = ordinary_fence {
            if marker == open_marker && length >= open_length && info.trim().is_empty() {
                ordinary_fence = None;
            }
            continue;
        }
        if action_start.is_some() && action_end.is_none() {
            if marker != '`' || length != 3 || !info.trim().is_empty() {
                continue;
            }
            let value: Value = serde_json::from_str(&content[action_body..line_start])
                .map_err(|_| "The AI returned malformed project-actions JSON. No file changes were applied. Ask it to retry with a complete version 1 action block.")?;
            let object = value.as_object().ok_or("The project-actions block must be a version 1 object; no file changes were applied.")?;
            if object.len() != 2
                || object.get("version").and_then(Value::as_u64) != Some(1)
                || !object.contains_key("writes")
            {
                return Err("The project-actions block must contain only version: 1 and a writes array; no file changes were applied.".into());
            }
            let proposals = object["writes"].as_array().filter(|items| !items.is_empty() && items.len() <= 8)
                .ok_or("The project-actions block must contain between 1 and 8 file writes; no file changes were applied.")?;
            writes = proposals
                .iter()
                .map(parse_write_proposal)
                .collect::<Result<Vec<_>, _>>()?;
            action_end = Some(offset);
            continue;
        }
        if marker == '`' && length == 3 && info.trim_end() == "project-actions" {
            if !enable_actions {
                return Err("File actions are disabled in this chat mode. Switch to Assistant mode and request the change again; no file changes were applied.".into());
            }
            if action_start.is_some() {
                return Err("The AI returned multiple project-actions blocks. Ask it for one block with at most 8 writes; no file changes were applied.".into());
            }
            action_start = Some(line_start);
            action_body = offset;
        } else {
            ordinary_fence = Some((marker, length));
        }
    }
    match (action_start, action_end) {
        (Some(start), Some(end)) => Ok((format!("{}{}", &content[..start], &content[end..]).trim().to_string(), writes)),
        (Some(_), None) => Err("The AI returned an unfinished project-actions block. No file changes were applied. Ask it to retry with a complete action block.".into()),
        _ => Ok((content.to_string(), vec![])),
    }
}

pub(crate) fn assistant_completion(
    content: String,
    writes: Vec<WriteProposal>,
    enable_actions: bool,
) -> Result<AssistantCompletion, String> {
    if !enable_actions && !writes.is_empty() {
        return Err("File actions are disabled in this chat mode. Switch to Assistant mode and request the change again; no file changes were applied.".into());
    }
    let (content, text_writes) = text_action_block(&content, enable_actions)?;
    if !writes.is_empty() && !text_writes.is_empty() {
        return Err("The AI mixed native tool calls and a project-actions block. Ask it to use one action format; no file changes were applied.".into());
    }
    let writes = if writes.is_empty() {
        text_writes
    } else {
        writes
    };
    let writes = if writes.is_empty() {
        writes
    } else {
        validate_proposals(writes)?
    };
    let content = if content.trim().is_empty() && !writes.is_empty() {
        "The assistant proposed these file changes.".into()
    } else {
        content
    };
    if content.trim().is_empty() {
        return Err("The provider returned no final text or supported file actions.".into());
    }
    Ok(AssistantCompletion { content, writes })
}

#[derive(Serialize)]
pub(crate) struct AiModel {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Connection {
    Ready,
    SignIn,
    Missing,
    Setup,
    Unavailable,
}

#[derive(Serialize)]
pub(crate) struct Catalog {
    pub connection: Connection,
    pub models: Vec<AiModel>,
    pub detail: Option<String>,
}

impl Catalog {
    pub fn new(connection: Connection, detail: impl Into<Option<String>>) -> Self {
        Self {
            connection,
            models: Vec::new(),
            detail: detail.into(),
        }
    }
}

pub(crate) fn valid_model(model: &str) -> bool {
    !model.is_empty() && model.len() <= 200 && !model.chars().any(char::is_control)
}

#[tauri::command]
pub(crate) async fn ai_preferences(state: State<'_, NativeState>) -> Result<AiPreferences, String> {
    let ai = state.ai.clone();
    tauri::async_runtime::spawn_blocking(move || ai.preferences())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn set_ai_selection(
    state: State<'_, NativeState>,
    mode: AiMode,
    choice: ModelChoice,
) -> Result<AiPreferences, String> {
    if choice.provider == Provider::Claude
        || choice
            .model
            .as_deref()
            .is_some_and(|model| !valid_model(model))
    {
        return Err("Choose an available provider and a valid model.".into());
    }
    let ai = state.ai.clone();
    tauri::async_runtime::spawn_blocking(move || {
        ai.update(|preferences| {
            preferences.selections.insert(mode, choice);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn save_preferred_local_models(
    state: State<'_, NativeState>,
    provider: Provider,
    models: Vec<String>,
) -> Result<AiPreferences, String> {
    if provider.endpoint().is_none()
        || models.len() > 100
        || models.iter().any(|model| !valid_model(model))
    {
        return Err("Save up to 100 preferred models with valid model IDs.".into());
    }
    let ai = state.ai.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut seen = HashSet::new();
        ai.update(|preferences| {
            let models: Vec<_> = models
                .into_iter()
                .filter(|model| seen.insert(model.clone()))
                .collect();
            if provider == Provider::Local {
                preferences.preferred_local_models.clone_from(&models);
            }
            preferences.preferred_models.insert(provider, models);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn ai_provider_catalog(
    state: State<'_, NativeState>,
    provider: Provider,
) -> Result<Catalog, String> {
    let Some(endpoint_provider) = provider.endpoint() else {
        return Ok(ai_cli::catalog(provider, &state.ai.dir).await);
    };
    let settings = work(state.core.clone(), |core| core.settings()).await?;
    let Some(endpoint) = settings.endpoint(endpoint_provider) else {
        return Ok(Catalog::new(Connection::Setup, None));
    };
    if !endpoint.enabled || endpoint.base_url.trim().is_empty() {
        return Ok(Catalog::new(Connection::Setup, None));
    }
    let mut catalog = Catalog::new(Connection::Ready, None);
    match integrations::list_models(&endpoint.base_url, endpoint_provider).await {
        Ok(models) => catalog.models = models,
        Err(error) => catalog.detail = Some(error),
    }
    Ok(catalog)
}

#[tauri::command]
pub(crate) async fn test_ai_provider(
    state: State<'_, NativeState>,
    provider: Provider,
) -> Result<String, String> {
    if provider != Provider::Cursor {
        return Err("Connection testing is available for Cursor.".into());
    }
    let target = ai_cli::Target::detect(provider, &state.ai.dir, Some("auto".into()))?;
    target
        .complete(
            vec![serde_json::json!({
                "role": "user",
                "content": "Connection diagnostic. Reply with the single word OK. Do not use tools."
            })],
            std::time::Duration::from_secs(60),
        )
        .await?;
    Ok("Cursor replied successfully using Auto. No project content was sent.".into())
}

#[tauri::command]
pub(crate) async fn open_ai_provider(
    state: State<'_, NativeState>,
    provider: Provider,
    sign_in: bool,
) -> Result<(), String> {
    ai_cli::open(provider, &state.ai.dir, sign_in).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_presets_route_to_their_own_endpoint_and_restore_model_choices() {
        let dir = tempfile::tempdir().unwrap();
        let ai = AiState::new(dir.path().to_path_buf());
        for provider in [
            Provider::Ollama,
            Provider::Openai,
            Provider::Gemini,
            Provider::Openrouter,
            Provider::Deepseek,
            Provider::Groq,
            Provider::Mistral,
        ] {
            let mut settings = Settings::default();
            settings.normalize_ai_providers();
            let endpoint_provider = provider.endpoint().unwrap();
            let endpoint = settings
                .ai_providers
                .iter_mut()
                .find(|entry| entry.provider == endpoint_provider)
                .unwrap();
            endpoint.enabled = true;
            endpoint.model = "default-model".into();
            let expected_url = endpoint.base_url.clone();
            ai.update(|preferences| {
                preferences.selections.insert(
                    AiMode::Assistant,
                    ModelChoice {
                        provider,
                        model: Some("preferred-model".into()),
                    },
                );
            })
            .unwrap();
            let request = ai.request(settings.clone(), AiMode::Assistant).unwrap();
            assert!(request.target.is_none());
            assert_eq!(request.settings.ai_provider, endpoint_provider);
            assert_eq!(request.settings.ai_base_url, expected_url);
            assert_eq!(request.settings.ai_model, "preferred-model");
            settings
                .ai_providers
                .iter_mut()
                .find(|entry| entry.provider == endpoint_provider)
                .unwrap()
                .enabled = false;
            assert!(ai.request(settings, AiMode::Assistant).is_err());
            let serialized = serde_json::to_value(provider).unwrap();
            assert_eq!(
                serde_json::from_value::<EndpointProvider>(serialized).unwrap(),
                endpoint_provider
            );
        }
    }

    #[test]
    fn explicit_text_actions_are_extracted_without_claiming_a_write() {
        let response = "Here is the proposed summary.\n\n```project-actions\n{\"version\":1,\"writes\":[{\"path\":\"Docs/Summary.md\",\"content\":\"# Summary\\nBilled: 250\"}]}\n```\n\nPlease review it.";
        let completion = assistant_completion(response.into(), vec![], true).unwrap();
        assert_eq!(
            completion.content,
            "Here is the proposed summary.\n\n\nPlease review it."
        );
        assert_eq!(completion.writes.len(), 1);
        assert_eq!(completion.writes[0].path, "Docs/Summary.md");
        assert_eq!(completion.writes[0].content, "# Summary\nBilled: 250");
        assert!(!completion.content.contains("project-actions"));
        let completion = assistant_completion("```project-actions\n{\"version\":1,\"writes\":[{\"path\":\"empty.md\",\"content\":\"\"}]}\n```".into(), vec![], true).unwrap();
        assert_eq!(
            completion.content,
            "The assistant proposed these file changes."
        );
    }

    #[test]
    fn examples_in_ordinary_fences_and_blockquotes_are_not_actions() {
        for text in [
            "````markdown\n```project-actions\n{\"version\":1,\"writes\":[{\"path\":\"example.md\",\"content\":\"example\"}]}\n```\n````",
            "> ```project-actions\n> {\"version\":1,\"writes\":[]}\n> ```",
            "Mention ```project-actions inline as an example.",
            "    ```project-actions\n    {}\n    ```",
        ] {
            let completion = assistant_completion(text.into(), vec![], false).unwrap();
            assert_eq!(completion.content, text);
            assert!(completion.writes.is_empty());
        }
    }

    #[test]
    fn invalid_or_disabled_text_actions_fail_without_returning_write_claims() {
        for text in [
            "I saved it.\n```project-actions\n{bad json}\n```",
            "```project-actions\n{\"version\":2,\"writes\":[{\"path\":\"a.md\",\"content\":\"a\"}]}\n```",
            "```project-actions\n{\"version\":1,\"writes\":[]}\n```",
            "```project-actions\n{\"version\":1,\"writes\":[{\"path\":\"../outside.md\",\"content\":\"a\"}]}\n```",
            "```project-actions\n{\"version\":1,\"writes\":[{\"path\":\"a.md\",\"content\":\"a\",\"command\":\"unsafe\"}]}\n```",
            "```project-actions\n{\"version\":1,\"writes\":[{\"path\":\"a.md\",\"content\":\"a\"}]}",
        ] {
            assert!(assistant_completion(text.into(), vec![], true).is_err(), "{text}");
        }
        let valid = "```project-actions\n{\"version\":1,\"writes\":[{\"path\":\"a.md\",\"content\":\"a\"}]}\n```";
        assert!(assistant_completion(valid.into(), vec![], false)
            .unwrap_err()
            .contains("disabled"));
        assert!(
            assistant_completion(format!("{valid}\n{valid}"), vec![], true)
                .unwrap_err()
                .contains("multiple")
        );
        assert!(assistant_completion(
            valid.into(),
            vec![WriteProposal {
                path: "b.md".into(),
                content: "b".into()
            }],
            true
        )
        .unwrap_err()
        .contains("mixed"));
    }

    #[test]
    fn action_proposals_are_bounded_and_nul_free_before_native_execution() {
        assert!(assistant_completion(
            "Proposed.".into(),
            (0..9)
                .map(|index| WriteProposal {
                    path: format!("{index}.md"),
                    content: "a".into()
                })
                .collect(),
            true
        )
        .is_err());
        assert!(assistant_completion(
            "Proposed.".into(),
            vec![WriteProposal {
                path: "a.md".into(),
                content: "x".repeat(1024 * 1024 + 1)
            }],
            true
        )
        .is_err());
        assert!(assistant_completion(
            "Proposed.".into(),
            vec![WriteProposal {
                path: "a.md".into(),
                content: "a\0b".into()
            }],
            true
        )
        .is_err());
    }

    #[test]
    fn each_mode_restores_its_own_model_and_unset_modes_use_the_existing_default() {
        let dir = tempfile::tempdir().unwrap();
        let ai = AiState::new(dir.path().to_path_buf());
        let settings = Settings {
            ai_base_url: "http://localhost:1234/v1".into(),
            ai_model: "existing".into(),
            ..Settings::default()
        };
        ai.update(|preferences| {
            preferences.selections.insert(
                AiMode::Inspector,
                ModelChoice {
                    provider: Provider::Local,
                    model: Some("draft".into()),
                },
            );
        })
        .unwrap();
        ai.update(|preferences| {
            preferences.preferred_local_models.push("quick".into());
            preferences.selections.insert(
                AiMode::Assistant,
                ModelChoice {
                    provider: Provider::Local,
                    model: Some("quick".into()),
                },
            );
        })
        .unwrap();
        let reopened = AiState::new(dir.path().to_path_buf());
        assert_eq!(
            reopened.preferences().unwrap().preferred_local_models,
            ["quick"]
        );
        for (mode, expected) in [
            (AiMode::Inspector, "draft"),
            (AiMode::Assistant, "quick"),
            (AiMode::GlobalAssistant, "existing"),
            (AiMode::WordParser, "existing"),
        ] {
            let request = reopened.request(settings.clone(), mode).unwrap();
            assert_eq!(request.settings.ai_model, expected);
            assert!(request.target.is_none());
        }
    }
}
