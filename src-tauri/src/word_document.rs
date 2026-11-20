//! Local OOXML extraction. Document text is data, never instructions or executable markup.
use roxmltree::{Document, Node};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{Cursor, Read},
};

type Result<T> = std::result::Result<T, String>;
const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const STRICT_W: &str = "http://purl.oclc.org/ooxml/wordprocessingml/main";
const R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const STRICT_R: &str = "http://purl.oclc.org/ooxml/officeDocument/relationships";
const LIMIT: usize = crate::assistant_sources::MAX_CONTEXT_BYTES;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WordDocument {
    pub markdown: String,
    pub paragraphs: Vec<Value>,
    pub sections: Vec<Value>,
    pub warnings: Vec<String>,
}

fn word(node: Node<'_, '_>, name: &str) -> bool {
    node.is_element()
        && node.tag_name().name() == name
        && matches!(node.tag_name().namespace(), Some(W | STRICT_W))
}
fn child<'a, 'b>(node: Node<'a, 'b>, name: &str) -> Option<Node<'a, 'b>> {
    node.children().find(|n| word(*n, name))
}
fn attr<'a, 'b: 'a>(node: Node<'a, 'b>, name: &str) -> Option<&'a str> {
    node.attribute((W, name))
        .or_else(|| node.attribute((STRICT_W, name)))
}
fn value(node: Node<'_, '_>, name: &str) -> Option<String> {
    child(node, name)
        .and_then(|n| attr(n, "val"))
        .map(str::to_string)
}
fn xml(text: &str) -> Result<Document<'_>> {
    let doc = Document::parse_with_options(
        text,
        roxmltree::ParsingOptions {
            allow_dtd: false,
            nodes_limit: 250_000,
            ..Default::default()
        },
    )
    .map_err(|e| format!("Word XML could not be parsed completely: {e}"))?;
    if doc
        .descendants()
        .any(|n| n.ancestors().take(130).count() > 128)
    {
        return Err("Word XML exceeds the supported nesting depth.".into());
    }
    Ok(doc)
}

#[derive(Clone, Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Format {
    #[serde(skip_serializing_if = "Option::is_none")]
    font: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    font_theme: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size_pt: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    italic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    strike: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    underline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    highlight: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vertical_align: Option<String>,
}
impl Format {
    fn apply(&mut self, other: &Self) {
        if other.font_theme.is_some() && other.font.is_none() {
            self.font = None;
        }
        if other.font.is_some() && other.font_theme.is_none() {
            self.font_theme = None;
        }
        macro_rules! take { ($($f:ident),*) => { $(if other.$f.is_some() { self.$f = other.$f.clone(); })* }; }
        take!(
            font,
            font_theme,
            size_pt,
            bold,
            italic,
            strike,
            underline,
            color,
            highlight,
            vertical_align
        );
    }
    fn read(node: Option<Node<'_, '_>>) -> Self {
        let Some(node) = node else {
            return Self::default();
        };
        let flag = |name| {
            child(node, name).map(|n| !matches!(attr(n, "val"), Some("0" | "false" | "off")))
        };
        Self {
            font: child(node, "rFonts")
                .and_then(|n| attr(n, "ascii").or_else(|| attr(n, "hAnsi")))
                .map(str::to_string),
            font_theme: child(node, "rFonts")
                .and_then(|n| attr(n, "asciiTheme").or_else(|| attr(n, "hAnsiTheme")))
                .map(str::to_string),
            size_pt: value(node, "sz")
                .and_then(|v| v.parse::<f32>().ok())
                .map(|v| v / 2.0),
            bold: flag("b"),
            italic: flag("i"),
            strike: flag("strike"),
            underline: value(node, "u"),
            color: value(node, "color"),
            highlight: value(node, "highlight"),
            vertical_align: value(node, "vertAlign"),
        }
    }
}

#[derive(Default)]
struct Style {
    based_on: Option<String>,
    name: String,
    heading: Option<usize>,
    format: Format,
    list: Option<(String, usize)>,
}
fn list(node: Node<'_, '_>) -> Option<(String, usize)> {
    let num = child(node, "numPr")?;
    let id = value(num, "numId")?;
    if id == "0" {
        return None;
    }
    Some((
        id,
        value(num, "ilvl").and_then(|v| v.parse().ok()).unwrap_or(0),
    ))
}
fn escape(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if matches!(
            c,
            '\\' | '*' | '_' | '[' | ']' | '`' | '<' | '>' | '#' | '~'
        ) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

struct Extractor {
    styles: HashMap<String, Style>,
    default_style: String,
    defaults: Format,
    theme_fonts: HashMap<String, String>,
    numbering: HashMap<(String, usize), (String, usize)>,
    counters: HashMap<(String, usize), usize>,
    relationships: HashMap<String, String>,
    document: WordDocument,
}
impl Extractor {
    fn run_format(&self, node: Node<'_, '_>, base: &Format) -> Format {
        let mut format = base.clone();
        if let Some(id) = child(node, "rPr").and_then(|p| value(p, "rStyle")) {
            format.apply(&self.style(&id, false).0);
        }
        format.apply(&Format::read(child(node, "rPr")));
        if format.font.is_none() {
            format.font = format
                .font_theme
                .as_ref()
                .and_then(|theme| {
                    self.theme_fonts.get(if theme.starts_with("major") {
                        "major"
                    } else {
                        "minor"
                    })
                })
                .cloned();
        }
        format
    }
    fn style(&self, id: &str, defaults: bool) -> (Format, Option<usize>, Option<(String, usize)>) {
        let mut chain = vec![];
        let mut next = Some(id);
        while let Some(id) = next {
            if chain.contains(&id) || chain.len() >= 32 {
                break;
            }
            chain.push(id);
            next = self.styles.get(id).and_then(|s| s.based_on.as_deref());
        }
        let mut f = if defaults {
            self.defaults.clone()
        } else {
            Format::default()
        };
        let mut heading = None;
        let mut numbering = None;
        for id in chain.into_iter().rev() {
            if let Some(s) = self.styles.get(id) {
                f.apply(&s.format);
                heading = s.heading.or(heading);
                numbering = s.list.clone().or(numbering);
            }
            let name = self
                .styles
                .get(id)
                .map(|s| s.name.as_str())
                .unwrap_or(id)
                .to_lowercase()
                .replace(' ', "");
            if name == "title" {
                heading = Some(1);
            }
            if let Some(level) = name
                .strip_prefix("heading")
                .and_then(|v| v.parse::<usize>().ok())
            {
                heading = Some(level.clamp(1, 6));
            }
        }
        (f, heading, numbering)
    }
    fn inline(&self, node: Node<'_, '_>, base: &Format, runs: &mut Vec<Value>) -> String {
        if word(node, "del") || word(node, "moveFrom") || word(node, "instrText") {
            return String::new();
        }
        if word(node, "r") {
            let format = self.run_format(node, base);
            let raw: String = node
                .children()
                .map(|n| {
                    if word(n, "t") {
                        n.text().unwrap_or("").to_string()
                    } else if word(n, "tab") {
                        "\t".into()
                    } else if word(n, "br") || word(n, "cr") {
                        "\n".into()
                    } else if word(n, "footnoteReference") || word(n, "endnoteReference") {
                        format!(
                            "[^{}-{}]",
                            n.tag_name().name(),
                            attr(n, "id").unwrap_or("?")
                        )
                    } else {
                        self.inline(n, &format, runs)
                    }
                })
                .collect();
            if raw.is_empty() {
                return raw;
            }
            let properties = child(node,"rPr").map(|p| p.descendants().filter(Node::is_element).skip(1).map(|n| json!({"name":n.tag_name().name(),"attributes":n.attributes().map(|a| (a.name().to_string(),a.value().to_string())).collect::<HashMap<_,_>>()})).collect::<Vec<_>>()).unwrap_or_default();
            runs.push(json!({"text":raw, "format":format, "properties":properties}));
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return raw;
            }
            let mut text = escape(trimmed);
            // References are generated locally, not taken from document markup.
            for n in node
                .children()
                .filter(|n| word(*n, "footnoteReference") || word(*n, "endnoteReference"))
            {
                let reference = format!(
                    "[^{}-{}]",
                    n.tag_name().name(),
                    attr(n, "id").unwrap_or("?")
                );
                text = text.replace(&escape(&reference), &reference);
            }
            if format.bold == Some(true) {
                text = format!("**{text}**");
            }
            if format.italic == Some(true) {
                text = format!("*{text}*");
            }
            if format.strike == Some(true) {
                text = format!("~~{text}~~");
            }
            format!(
                "{}{}{}",
                &raw[..raw.len() - raw.trim_start().len()],
                text,
                &raw[raw.trim_end().len()..]
            )
        } else if word(node, "hyperlink") {
            let text: String = node
                .children()
                .map(|n| self.inline(n, base, runs))
                .collect();
            let target = node
                .attribute((R, "id"))
                .or_else(|| node.attribute((STRICT_R, "id")))
                .and_then(|id| self.relationships.get(id));
            if let Some(url) = target.filter(|url| {
                url::Url::parse(url)
                    .is_ok_and(|u| matches!(u.scheme(), "https" | "http" | "mailto"))
            }) {
                format!(
                    "[{text}]({})",
                    url.replace('(', "%28")
                        .replace(')', "%29")
                        .replace(' ', "%20")
                )
            } else {
                text
            }
        } else if node.is_element() && matches!(node.tag_name().name(), "docPr" | "cNvPr") {
            let label = node
                .attribute("descr")
                .or_else(|| node.attribute("title"))
                .unwrap_or("Image");
            format!("[Image: {}]", escape(label))
        } else {
            node.children()
                .map(|n| self.inline(n, base, runs))
                .collect()
        }
    }
    fn paragraph(&mut self, p: Node<'_, '_>, part: &str) -> String {
        let props = child(p, "pPr");
        let id = props
            .and_then(|n| value(n, "pStyle"))
            .unwrap_or_else(|| self.default_style.clone());
        let (mut base, mut heading, inherited_list) = self.style(&id, true);
        base.apply(&Format::read(props.and_then(|n| child(n, "rPr"))));
        if let Some(level) = props
            .and_then(|n| value(n, "outlineLvl"))
            .and_then(|v| v.parse::<usize>().ok())
        {
            heading = (level < 9).then_some((level + 1).min(6));
        }
        let numbering = if props.and_then(|p| child(p, "numPr")).is_some() {
            props.and_then(list)
        } else {
            inherited_list
        };
        let mut runs = vec![];
        let mut text = String::new();
        let mut pending: Option<(String, Format)> = None;
        let flush = |pending: &mut Option<(String, Format)>, text: &mut String| {
            if let Some((raw, f)) = pending.take() {
                let mut value = escape(raw.trim());
                if f.bold == Some(true) {
                    value = format!("**{value}**");
                }
                if f.italic == Some(true) {
                    value = format!("*{value}*");
                }
                if f.strike == Some(true) {
                    value = format!("~~{value}~~");
                }
                if raw.trim().is_empty() {
                    text.push_str(&raw);
                } else {
                    text.push_str(&format!(
                        "{}{}{}",
                        &raw[..raw.len() - raw.trim_start().len()],
                        value,
                        &raw[raw.trim_end().len()..]
                    ));
                }
            }
        };
        for n in p.children().filter(|n| !word(*n, "pPr")) {
            let before = runs.len();
            let rendered = self.inline(n, &base, &mut runs);
            if word(n, "r")
                && runs.len() == before + 1
                && n.children().filter(Node::is_element).all(|c| {
                    ["rPr", "t", "tab", "br", "cr"]
                        .iter()
                        .any(|name| word(c, name))
                })
            {
                let f = self.run_format(n, &base);
                let raw = runs[before]["text"].as_str().unwrap_or_default();
                if let Some((value, _)) = pending.as_mut().filter(|(_, previous)| {
                    previous.bold == f.bold
                        && previous.italic == f.italic
                        && previous.strike == f.strike
                }) {
                    value.push_str(raw);
                } else {
                    flush(&mut pending, &mut text);
                    pending = Some((raw.into(), f));
                }
            } else {
                flush(&mut pending, &mut text);
                text.push_str(&rendered);
            }
        }
        flush(&mut pending, &mut text);
        let raw: String = runs.iter().filter_map(|r| r["text"].as_str()).collect();
        if text.trim().is_empty() {
            return String::new();
        }
        let mut prefix = heading
            .map(|h| format!("{} ", "#".repeat(h)))
            .unwrap_or_default();
        if let Some((num, level)) = &numbering {
            let (kind, start) = self
                .numbering
                .get(&(num.clone(), *level))
                .cloned()
                .unwrap_or(("bullet".into(), 1));
            self.counters
                .retain(|(id, lvl), _| id != num || lvl <= level);
            let count = self.counters.entry((num.clone(), *level)).or_insert(start);
            prefix = format!(
                "{}{}",
                "    ".repeat((*level).min(8)),
                if kind == "bullet" {
                    "- ".into()
                } else {
                    format!("{count}. ")
                }
            );
            *count += 1;
        }
        let properties = props.map(|p| p.descendants().filter(Node::is_element).skip(1).map(|n| json!({"name":n.tag_name().name(),"attributes":n.attributes().map(|a| (a.name().to_string(),a.value().to_string())).collect::<HashMap<_,_>>()})).collect::<Vec<_>>()).unwrap_or_default();
        self.document.paragraphs.push(json!({"part":part,"text":raw,"style":id,"headingLevel":heading,"alignment":props.and_then(|n| value(n,"jc")),"list":numbering,"properties":properties,"runs":runs}));
        format!("{prefix}{}\n\n", text.trim())
    }
    fn blocks(&mut self, node: Node<'_, '_>, part: &str, depth: usize) -> Result<String> {
        if depth > 64 {
            return Err("Word layout exceeds the supported nesting depth.".into());
        }
        let mut out = String::new();
        for n in node.children().filter(Node::is_element) {
            if word(n, "p") {
                out.push_str(&self.paragraph(n, part));
            } else if word(n, "footnote") || word(n, "endnote") {
                if attr(n, "type").is_some() {
                    continue;
                }
                let reference = if word(n, "footnote") {
                    "footnoteReference"
                } else {
                    "endnoteReference"
                };
                let text = self.blocks(n, part, depth + 1)?;
                out.push_str(&format!(
                    "[^{}-{}]: {}\n\n",
                    reference,
                    attr(n, "id").unwrap_or("?"),
                    text.trim().replace('\n', "\n    ")
                ));
            } else if word(n, "tbl") {
                let mut rows = vec![];
                for row in n.children().filter(|n| word(*n, "tr")) {
                    let mut cells = vec![];
                    for cell in row.children().filter(|n| word(*n, "tc")) {
                        let text = self.blocks(cell, part, depth + 1)?;
                        cells.push(text.trim().replace('\n', "<br>").replace('|', "\\|"));
                        let span = child(cell, "tcPr")
                            .and_then(|p| value(p, "gridSpan"))
                            .and_then(|v| v.parse::<usize>().ok())
                            .unwrap_or(1);
                        if span > 100 {
                            return Err("Word table span exceeds extraction limits.".into());
                        }
                        for _ in 1..span {
                            cells.push(String::new());
                        }
                    }
                    rows.push(cells);
                }
                let width = rows.iter().map(Vec::len).max().unwrap_or(0);
                for (i, row) in rows.iter_mut().enumerate() {
                    row.resize(width, String::new());
                    out.push_str(&format!("| {} |\n", row.join(" | ")));
                    if i == 0 {
                        out.push_str(&format!("| {} |\n", vec!["---"; width].join(" | ")));
                    }
                }
                out.push('\n');
            } else if word(n, "sectPr") {
                self.document.sections.push(json!({"part":part,"properties":n.descendants().filter(Node::is_element).skip(1).map(|n| json!({"name":n.tag_name().name(),"attributes":n.attributes().map(|a| (a.name().to_string(),a.value().to_string())).collect::<HashMap<_,_>>()})).collect::<Vec<_>>()}));
            } else if !word(n, "del")
                && !word(n, "moveFrom")
                && !word(n, "pPr")
                && !word(n, "tcPr")
                && !word(n, "tblPr")
            {
                out.push_str(&self.blocks(n, part, depth + 1)?);
            }
            if out.len() > LIMIT {
                return Err("Word exceeds 512 KiB of extracted text. Split the document; no content was truncated.".into());
            }
        }
        Ok(out)
    }
}

pub(crate) fn extract(bytes: &[u8]) -> Result<WordDocument> {
    crate::assistant_sources::check_archive(bytes)?;
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
    let mut parts = HashMap::new();
    let mut expanded = 0usize;
    const MAX_XML: usize = 32 * 1024 * 1024;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let name = entry.name().map_err(|e| e.to_string())?.to_string();
        if name.starts_with("word/") && (name.ends_with(".xml") || name.ends_with(".rels")) {
            let mut text = String::new();
            (&mut entry)
                .take((MAX_XML - expanded + 1) as u64)
                .read_to_string(&mut text)
                .map_err(|e| e.to_string())?;
            expanded += text.len();
            if expanded > MAX_XML {
                return Err("Word XML expands beyond the 32 MiB extraction limit.".into());
            }
            parts.insert(name, text);
        }
    }
    let mut ex = Extractor { styles: HashMap::new(), default_style: "Normal".into(), defaults: Format::default(), theme_fonts: HashMap::new(), numbering: HashMap::new(), counters: HashMap::new(), relationships: HashMap::new(), document: WordDocument { markdown: String::new(), paragraphs: vec![], sections: vec![], warnings: vec!["Markdown preserves semantic formatting. Exact fonts, sizes, colours, alignment and section layout are retained in formatting details; use visual parsing to inspect rendered pages. Images are represented by descriptions; merged tables and complex layout may be simplified. Deleted revisions are omitted; inserted revisions are included.".into()] } };
    if let Some(text) = parts.get("word/theme/theme1.xml") {
        let doc = xml(text)?;
        for (tag, key) in [("majorFont", "major"), ("minorFont", "minor")] {
            if let Some(font) = doc
                .descendants()
                .find(|n| n.is_element() && n.tag_name().name() == tag)
                .and_then(|n| {
                    n.children()
                        .find(|n| n.is_element() && n.tag_name().name() == "latin")
                })
                .and_then(|n| n.attribute("typeface"))
            {
                ex.theme_fonts.insert(key.into(), font.into());
            }
        }
    }
    if let Some(text) = parts.get("word/styles.xml") {
        let doc = xml(text)?;
        ex.defaults = Format::read(
            doc.descendants()
                .find(|n| word(*n, "rPrDefault"))
                .and_then(|n| child(n, "rPr")),
        );
        for node in doc.descendants().filter(|n| word(*n, "style")) {
            let Some(id) = attr(node, "styleId") else {
                continue;
            };
            if attr(node, "default") == Some("1") && attr(node, "type") == Some("paragraph") {
                ex.default_style = id.into();
            }
            let p = child(node, "pPr");
            ex.styles.insert(
                id.into(),
                Style {
                    based_on: value(node, "basedOn"),
                    name: value(node, "name").unwrap_or_else(|| id.into()),
                    heading: p
                        .and_then(|n| value(n, "outlineLvl"))
                        .and_then(|v| v.parse::<usize>().ok())
                        .filter(|v| *v < 9)
                        .map(|v| (v + 1).min(6)),
                    format: Format::read(child(node, "rPr")),
                    list: p.and_then(list),
                },
            );
        }
    }
    if let Some(text) = parts.get("word/numbering.xml") {
        let doc = xml(text)?;
        for num in doc.descendants().filter(|n| word(*n, "num")) {
            let Some(id) = attr(num, "numId") else {
                continue;
            };
            let abstract_id = value(num, "abstractNumId").unwrap_or_default();
            if let Some(def) = doc.descendants().find(|n| {
                word(*n, "abstractNum") && attr(*n, "abstractNumId") == Some(abstract_id.as_str())
            }) {
                for lvl in def.children().filter(|n| word(*n, "lvl")) {
                    let level = attr(lvl, "ilvl").and_then(|v| v.parse().ok()).unwrap_or(0);
                    ex.numbering.insert(
                        (id.into(), level),
                        (
                            value(lvl, "numFmt").unwrap_or_else(|| "bullet".into()),
                            value(lvl, "start")
                                .and_then(|v| v.parse().ok())
                                .unwrap_or(1),
                        ),
                    );
                }
            }
        }
    }
    let mut names = parts
        .keys()
        .filter(|name| {
            *name == "word/document.xml"
                || name.starts_with("word/header")
                || name.starts_with("word/footer")
                || matches!(
                    name.as_str(),
                    "word/footnotes.xml" | "word/endnotes.xml" | "word/comments.xml"
                )
        })
        .cloned()
        .collect::<Vec<_>>();
    if !parts.contains_key("word/document.xml") {
        return Err("Word document has no word/document.xml content.".into());
    }
    names.sort_by_key(|n| (n != "word/document.xml", n.clone()));
    for name in names {
        let doc = xml(&parts[&name])?;
        ex.relationships.clear();
        let rels = format!("word/_rels/{}.rels", name.trim_start_matches("word/"));
        if let Some(text) = parts.get(&rels) {
            for n in xml(text)?
                .descendants()
                .filter(|n| n.is_element() && n.tag_name().name() == "Relationship")
            {
                if let (Some(id), Some(target)) = (n.attribute("Id"), n.attribute("Target")) {
                    ex.relationships.insert(id.into(), target.into());
                }
            }
        }
        let content = ex.blocks(doc.root_element(), &name, 0)?;
        if name == "word/document.xml" {
            ex.document.markdown.push_str(&content);
        } else if !content.trim().is_empty() {
            ex.document.markdown.push_str(&format!(
                "\n## {}\n\n{content}",
                name.trim_start_matches("word/").trim_end_matches(".xml")
            ));
        }
        if serde_json::to_vec(&ex.document)
            .map_err(|e| e.to_string())?
            .len()
            > 4 * LIMIT
        {
            return Err("Word text and formatting exceed the 2 MiB extraction limit. Split the document; no details were truncated.".into());
        }
    }
    ex.document.markdown = ex.document.markdown.trim().into();
    Ok(ex.document)
}

#[cfg(test)]
pub(crate) fn test_archive(entries: &[(&str, &str)]) -> Vec<u8> {
    use std::io::Write;
    let mut writer = zip::ZipWriter::new(Cursor::new(vec![]));
    for (name, text) in entries {
        writer
            .start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(text.as_bytes()).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn body(text: &str) -> String {
        format!(r#"<w:document xmlns:w="{W}" xmlns:r="{R}"><w:body>{text}</w:body></w:document>"#)
    }
    #[test]
    fn extracts_inherited_fonts_direct_formatting_headers_notes_and_links() {
        let doc = body(
            r#"<w:p><w:pPr><w:pStyle w:val="CustomHeading"/></w:pPr><w:r><w:t>Custom title</w:t></w:r></w:p>
        <w:p><w:pPr><w:pStyle w:val="CustomHeading"/></w:pPr><w:r><w:rPr><w:rStyle w:val="Emphasis"/><w:b w:val="0"/><w:sz w:val="29"/></w:rPr><w:t>Direct override</w:t></w:r></w:p>
        <w:p><w:hyperlink r:id="link"><w:r><w:t>Example &amp; details</w:t></w:r></w:hyperlink><w:r><w:footnoteReference w:id="1"/></w:r></w:p>
        <w:p><w:del><w:r><w:delText>Deleted</w:delText></w:r></w:del><w:ins><w:r><w:t>Inserted</w:t></w:r></w:ins></w:p>
        <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440"/></w:sectPr>"#,
        );
        let styles = format!(
            r#"<w:styles xmlns:w="{W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
        <w:style w:styleId="Base"><w:rPr><w:sz w:val="36"/><w:b/></w:rPr></w:style><w:style w:styleId="CustomHeading"><w:basedOn w:val="Base"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style><w:style w:styleId="Emphasis"><w:rPr><w:i/></w:rPr></w:style></w:styles>"#
        );
        let header = format!(
            r#"<w:hdr xmlns:w="{W}"><w:p><w:r><w:t>Running header</w:t></w:r></w:p></w:hdr>"#
        );
        let footnotes = format!(
            r#"<w:footnotes xmlns:w="{W}"><w:footnote w:id="-1" w:type="separator"><w:p/></w:footnote><w:footnote w:id="1"><w:p><w:r><w:t>Footnote content</w:t></w:r></w:p></w:footnote></w:footnotes>"#
        );
        let bytes = test_archive(&[
            ("word/document.xml", &doc),
            ("word/styles.xml", &styles),
            ("word/header1.xml", &header),
            ("word/footnotes.xml", &footnotes),
            (
                "word/_rels/document.xml.rels",
                r#"<Relationships><Relationship Id="link" Target="https://example.com/a(b)" Type="hyperlink"/></Relationships>"#,
            ),
            (
                "word/theme/theme1.xml",
                r#"<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:fontScheme><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>"#,
            ),
        ]);
        let result = extract(&bytes).unwrap();
        assert!(
            result.markdown.contains("## **Custom title**"),
            "{}",
            result.markdown
        );
        assert!(result.markdown.contains("## *Direct override*"));
        assert!(result
            .markdown
            .contains("[Example & details](https://example.com/a%28b%29)"));
        assert!(result.markdown.contains("[^footnoteReference-1]"));
        assert!(result
            .markdown
            .contains("[^footnoteReference-1]: Footnote content"));
        assert!(result.markdown.contains("Running header"));
        assert!(!result.markdown.contains("Deleted"));
        assert!(result.markdown.contains("Inserted"));
        assert_eq!(result.paragraphs[0]["runs"][0]["format"]["font"], "Aptos");
        assert_eq!(result.paragraphs[0]["runs"][0]["format"]["sizePt"], 18.0);
        assert_eq!(result.paragraphs[1]["runs"][0]["format"]["sizePt"], 14.5);
        assert_eq!(
            result.sections[0]["properties"][0]["attributes"]["w"],
            "11906"
        );
    }
    #[test]
    fn preserves_numbered_nested_lists_and_escaped_table_cells() {
        let list = |level, text| {
            format!(
                r#"<w:p><w:pPr><w:numPr><w:ilvl w:val="{level}"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>{text}</w:t></w:r></w:p>"#
            )
        };
        let doc = body(&format!(
            r#"{}{}{}<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A | B</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Value</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"#,
            list(0, "First"),
            list(1, "Nested"),
            list(0, "Second")
        ));
        let numbering = format!(
            r#"<w:numbering xmlns:w="{W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="3"/><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="7"><w:abstractNumId w:val="0"/></w:num></w:numbering>"#
        );
        let result = extract(&test_archive(&[
            ("word/document.xml", &doc),
            ("word/numbering.xml", &numbering),
        ]))
        .unwrap();
        assert!(
            result
                .markdown
                .contains("3. First\n\n    - Nested\n\n4. Second"),
            "{}",
            result.markdown
        );
        assert!(result.markdown.contains(r"| A \| B | **Value** |"));
    }
    #[test]
    fn rejects_dtd_malformed_xml_and_preserves_literal_markup_as_text() {
        assert!(extract(&test_archive(&[("word/document.xml", "<!DOCTYPE x><x/>")])).is_err());
        assert!(extract(&test_archive(&[("word/document.xml", "<x>")])).is_err());
        let doc = body(
            "<w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt; **literal**</w:t></w:r></w:p>",
        );
        let result = extract(&test_archive(&[("word/document.xml", &doc)])).unwrap();
        assert!(result.markdown.contains(r"\<script\>"));
        assert!(result.markdown.contains(r"\*\*literal\*\*"));
    }

    #[test]
    fn adjacent_word_runs_form_one_markdown_emphasis_span_and_deep_xml_fails_cleanly() {
        let doc = body(
            r#"<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Hel</w:t></w:r><w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>lo</w:t></w:r></w:p>"#,
        );
        let result = extract(&test_archive(&[("word/document.xml", &doc)])).unwrap();
        assert_eq!(result.markdown, "**Hello**");
        assert_eq!(result.paragraphs[0]["runs"].as_array().unwrap().len(), 2);
        let deep = format!("{}{}", "<x>".repeat(130), "</x>".repeat(130));
        assert!(extract(&test_archive(&[("word/document.xml", &deep)]))
            .unwrap_err()
            .contains("nesting"));
    }
}
