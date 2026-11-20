use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub path: String,
    pub name: String,
    pub available: bool,
    #[serde(default = "source_connected")]
    pub connected: bool,
}

fn source_connected() -> bool {
    true
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub source_id: String,
    pub path: String,
    pub name: String,
    pub alias: String,
    pub client: String,
    pub tags: Vec<String>,
    pub color: String,
    pub pinned: bool,
    pub hidden: bool,
    pub last_opened: i64,
    pub modified_at: i64,
    pub available: bool,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPatch {
    pub alias: Option<String>,
    pub client: Option<String>,
    pub tags: Option<Vec<String>>,
    pub color: Option<String>,
    pub pinned: Option<bool>,
    pub hidden: Option<bool>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateFile {
    pub path: String,
    pub content: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub id: String,
    pub name: String,
    pub directories: Vec<String>,
    pub files: Vec<TemplateFile>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub id: String,
    pub name: String,
    pub executable: String,
    pub args: Vec<String>,
}
#[derive(Debug, Clone, Copy, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EndpointProvider {
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
}

impl Default for EndpointProvider {
    fn default() -> Self {
        Self::Local
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEndpointSettings {
    pub provider: EndpointProvider,
    pub enabled: bool,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub has_key: bool,
}

impl AiEndpointSettings {
    pub fn new(provider: EndpointProvider, enabled: bool, base_url: &str) -> Self {
        Self {
            provider,
            enabled,
            base_url: base_url.into(),
            model: String::new(),
            has_key: false,
        }
    }
}

fn default_ai_providers() -> Vec<AiEndpointSettings> {
    vec![
        AiEndpointSettings::new(EndpointProvider::Local, true, "http://127.0.0.1:1234/v1"),
        AiEndpointSettings::new(EndpointProvider::Unsloth, false, "http://127.0.0.1:8888/v1"),
        AiEndpointSettings::new(EndpointProvider::Ollama, false, "http://127.0.0.1:11434/v1"),
        AiEndpointSettings::new(EndpointProvider::Openai, false, "https://api.openai.com/v1"),
        AiEndpointSettings::new(
            EndpointProvider::Gemini,
            false,
            "https://generativelanguage.googleapis.com/v1beta/openai",
        ),
        AiEndpointSettings::new(
            EndpointProvider::Openrouter,
            false,
            "https://openrouter.ai/api/v1",
        ),
        AiEndpointSettings::new(
            EndpointProvider::Deepseek,
            false,
            "https://api.deepseek.com",
        ),
        AiEndpointSettings::new(
            EndpointProvider::Groq,
            false,
            "https://api.groq.com/openai/v1",
        ),
        AiEndpointSettings::new(
            EndpointProvider::Mistral,
            false,
            "https://api.mistral.ai/v1",
        ),
        AiEndpointSettings::new(EndpointProvider::Custom, false, ""),
    ]
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SupportedToolSettings {
    pub enabled: bool,
    pub desktop: bool,
    pub cli: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SupportedTools {
    pub cursor: SupportedToolSettings,
    pub claude: SupportedToolSettings,
    pub codex: SupportedToolSettings,
}

impl Default for SupportedTools {
    fn default() -> Self {
        Self {
            cursor: SupportedToolSettings {
                enabled: true,
                desktop: true,
                cli: false,
            },
            claude: SupportedToolSettings::default(),
            codex: SupportedToolSettings::default(),
        }
    }
}

impl SupportedTools {
    pub fn get(&self, id: &str) -> Option<&SupportedToolSettings> {
        match id {
            "cursor" => Some(&self.cursor),
            "claude" => Some(&self.claude),
            "codex" => Some(&self.codex),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub onboarding_completed: bool,
    #[serde(default)]
    pub default_template_id: String,
    #[serde(default)]
    pub files: FileSettings,
    pub tools: Vec<Tool>,
    #[serde(default)]
    pub supported_tools: SupportedTools,
    pub ai_base_url: String,
    pub ai_model: String,
    pub ai_has_key: bool,
    #[serde(default)]
    pub ai_providers: Vec<AiEndpointSettings>,
    #[serde(default)]
    pub ai_provider: EndpointProvider,
    pub scan_interval_seconds: u64,
    #[serde(default)]
    pub inspector: InspectorSettings,
    #[serde(default)]
    pub indexing: IndexSettings,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            onboarding_completed: false,
            default_template_id: String::new(),
            files: FileSettings::default(),
            tools: vec![],
            supported_tools: SupportedTools::default(),
            ai_base_url: "http://127.0.0.1:1234/v1".into(),
            ai_model: String::new(),
            ai_has_key: false,
            ai_providers: vec![],
            ai_provider: EndpointProvider::Local,
            scan_interval_seconds: 60,
            inspector: InspectorSettings::default(),
            indexing: IndexSettings::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FileSettings {
    pub remember_session: bool,
    pub restore_open_files: bool,
    pub remember_positions: bool,
    pub default_mode: String,
    pub wrap_lines: bool,
    pub line_numbers: bool,
    pub preview_layout: String,
    pub preview_width: u32,
    pub full_width_padding: u32,
    pub editor_font_size: u32,
    pub preview_font_size: u32,
}

impl Default for FileSettings {
    fn default() -> Self {
        Self {
            remember_session: true,
            restore_open_files: true,
            remember_positions: true,
            default_mode: "preview".into(),
            wrap_lines: true,
            line_numbers: true,
            preview_layout: "boxed".into(),
            preview_width: 960,
            full_width_padding: 16,
            editor_font_size: 12,
            preview_font_size: 13,
        }
    }
}

impl FileSettings {
    pub fn validate(&self) -> Result<(), String> {
        if !["preview", "edit", "split"].contains(&self.default_mode.as_str())
            || !["boxed", "full"].contains(&self.preview_layout.as_str())
            || !(320..=1800).contains(&self.preview_width)
            || self.full_width_padding > 80
            || !(9..=46).contains(&self.editor_font_size)
            || !(9..=46).contains(&self.preview_font_size)
        {
            return Err("Choose a valid file view, preview width (320–1800px), padding (0–80px) and font sizes (9–46px).".into());
        }
        Ok(())
    }
}

impl Settings {
    pub fn normalize_ai_providers(&mut self) {
        if self.ai_providers.is_empty() {
            self.ai_providers = default_ai_providers();
            if let Some(local) = self
                .ai_providers
                .iter_mut()
                .find(|entry| matches!(entry.provider, EndpointProvider::Local))
            {
                local.base_url.clone_from(&self.ai_base_url);
                local.model.clone_from(&self.ai_model);
                local.has_key = self.ai_has_key;
                local.enabled = !local.base_url.trim().is_empty();
            }
        }
        for fallback in default_ai_providers() {
            if !self
                .ai_providers
                .iter()
                .any(|entry| entry.provider == fallback.provider)
            {
                self.ai_providers.push(fallback);
            }
        }
        if let Some(local) = self
            .ai_providers
            .iter()
            .find(|entry| matches!(entry.provider, EndpointProvider::Local))
        {
            self.ai_base_url.clone_from(&local.base_url);
            self.ai_model.clone_from(&local.model);
            self.ai_has_key = local.has_key;
        }
    }

    pub fn endpoint(&self, provider: EndpointProvider) -> Option<&AiEndpointSettings> {
        self.ai_providers
            .iter()
            .find(|entry| entry.provider == provider)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorSettings {
    pub output_tokens: u32,
    pub timeout_minutes: u64,
    pub default_profile_id: String,
    pub profiles: Vec<InspectorProfile>,
    #[serde(default)]
    pub exclude_patterns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorProfile {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub templates: Vec<String>,
}

impl Default for InspectorSettings {
    fn default() -> Self {
        Self {
            output_tokens: 50_000,
            timeout_minutes: 45,
            default_profile_id: "standard".into(),
            exclude_patterns: vec![],
            profiles: vec![InspectorProfile {
                id: "standard".into(),
                name: "Standard overview".into(),
                prompt: concat!(
                    "Draft a PROJECT.md overview from the supplied local project evidence. ",
                    "Describe the project purpose, layout, technologies, documented setup, and known next steps where applicable. ",
                    "Cite relevant relative source paths. Preserve useful documented facts and tasks from an existing overview. ",
                    "Mark gaps and uncertain inferences clearly. Start the document with a top-level heading."
                ).into(),
                templates: vec![],
            }],
        }
    }
}

impl InspectorSettings {
    pub fn validate(&self) -> Result<(), String> {
        crate::inspector::validate_exclusions(&self.exclude_patterns)?;
        if !(1..=200_000).contains(&self.output_tokens)
            || !(1..=180).contains(&self.timeout_minutes)
        {
            return Err(
                "Inspector limits must be 1–200,000 output tokens and 1–180 minutes.".into(),
            );
        }
        if self.profiles.is_empty() || self.profiles.len() > 20 {
            return Err("Keep between 1 and 20 inspector prompt profiles.".into());
        }
        let mut ids = std::collections::HashSet::new();
        for profile in &self.profiles {
            if profile.id.trim().is_empty()
                || profile.id.len() > 80
                || !ids.insert(profile.id.as_str())
            {
                return Err("Inspector prompt profiles need unique IDs.".into());
            }
            if profile.name.trim().is_empty()
                || profile.name.chars().count() > 120
                || profile.prompt.trim().is_empty()
                || profile.prompt.len() > 16 * 1024
                || profile.prompt.contains('\0')
            {
                return Err(
                    "Each inspector profile needs a name and a prompt of up to 16 KiB.".into(),
                );
            }
            if profile.templates.len() > 8
                || profile
                    .templates
                    .iter()
                    .any(|template| template.trim().is_empty() || template.contains('\0'))
                || profile.templates.iter().map(String::len).sum::<usize>() > 32 * 1024
            {
                return Err(
                    "Use up to eight nonempty Markdown attachments totalling 32 KiB per profile."
                        .into(),
                );
            }
        }
        if !ids.contains(self.default_profile_id.as_str()) {
            return Err("Choose a default inspector prompt profile.".into());
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub running: bool,
    pub files: u64,
    pub projects: u64,
    pub last_indexed: i64,
    pub message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub sources: Vec<Source>,
    pub projects: Vec<Project>,
    pub templates: Vec<Template>,
    pub settings: Settings,
    pub index_status: IndexStatus,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub directory: bool,
    pub size: u64,
    pub modified_at: i64,
    #[serde(default)]
    pub ai_excluded: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_exclusion_reason: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDocument {
    pub path: String,
    pub content: String,
    pub revision: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub project_id: String,
    pub project_name: String,
    pub path: String,
    pub name: String,
    pub excerpt: String,
    pub directory: bool,
    pub depth: u32,
    pub match_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExclusionProfile {
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub folder_patterns: Vec<String>,
    pub file_patterns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct IndexSettings {
    pub follow_gitignore: bool,
    pub profiles: Vec<ExclusionProfile>,
    pub folder_patterns: Vec<String>,
    pub file_patterns: Vec<String>,
}

impl Default for IndexSettings {
    fn default() -> Self {
        crate::indexing::defaults()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIndexStats {
    pub project_id: String,
    pub project_name: String,
    pub files: u64,
    pub folders: u64,
    pub content_files: u64,
    pub excluded_entries: u64,
    pub skipped_files: u64,
    pub truncated_files: u64,
    pub last_indexed: i64,
    pub duration_ms: u64,
    pub status: String,
    pub message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub author: String,
    pub date: String,
    pub subject: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub available: bool,
    pub is_repo: bool,
    pub branch: String,
    pub changes: Vec<String>,
    pub commits: Vec<GitCommit>,
    pub message: String,
}
