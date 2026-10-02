//! Daemon-owned inventory of agent installations and profiles on this OS
//! user's machine. Paths remain local; only opaque IDs and bounded labels
//! are sent to Cloud. No process-list guesses or telemetry project IDs.

use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

static ROSTER_WRITE: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
const INTEGRATIONS: &[&str] = &[
    "claude",
    "codex",
    "copilot",
    "cursor",
    "opencode",
    "pi",
    "hermes",
    "openclaw",
    "factory",
    "devin",
    "antigravity",
    "goose",
];
const RECENT_SIGHTING_MS: i64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfile {
    pub instance_id: String,
    pub integration: String,
    pub settings_path: String,
    pub profile_label: String,
    pub scope: String,
    pub hook_installed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fingerprint: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRoster {
    pub schema_version: u32,
    pub generation: u64,
    pub agents: Vec<AgentProfile>,
}

pub fn roster_path() -> io::Result<PathBuf> {
    crate::paths::agent_roster_path()
}

fn safe_profile_label(label: &str) -> String {
    let name: String = label
        .chars()
        .filter(|c| !c.is_control())
        .take(80)
        .collect::<String>()
        .trim()
        .to_string();
    if name.is_empty() {
        "profile".into()
    } else {
        name
    }
}

fn profile(integration: &str, label: &str, settings: PathBuf) -> Option<AgentProfile> {
    let folder = settings.parent()?;
    if !folder.exists() {
        return None;
    }
    let fingerprint = fs::metadata(folder)
        .ok()
        .map(|m| format!("{}:{}", m.dev(), m.ino()));
    // This is only a hint. A hook-time sighting will make an installation
    // active; the Cloud API never treats this string as proof of identity.
    let hooked = fs::File::open(&settings)
        .ok()
        .and_then(|mut file| {
            let mut buf = vec![0u8; 131_073];
            let size = file.read(&mut buf).ok()?;
            (size <= 131_072).then(|| String::from_utf8_lossy(&buf[..size]).contains("failproofai"))
        })
        .unwrap_or(false);
    Some(AgentProfile {
        instance_id: String::new(),
        integration: integration.into(),
        settings_path: settings.to_string_lossy().into_owned(),
        profile_label: safe_profile_label(label),
        scope: "user".into(),
        hook_installed: hooked,
        last_seen_at: None,
        fingerprint,
    })
}

fn profiles_at(home: &Path) -> Vec<AgentProfile> {
    let mut out = Vec::new();
    for (integration, path) in [
        ("claude", ".claude/settings.json"),
        ("codex", ".codex/hooks.json"),
        ("copilot", ".copilot/hooks/failproofai.json"),
        ("cursor", ".cursor/hooks.json"),
        ("opencode", ".config/opencode/opencode.json"),
        ("pi", ".pi/agent/settings.json"),
        ("factory", ".factory/hooks.json"),
        ("devin", ".config/devin/config.json"),
        ("antigravity", ".gemini/config/hooks.json"),
        ("goose", ".agents/plugins/failproofai/hooks/hooks.json"),
    ] {
        if let Some(item) = profile(integration, "default", home.join(path)) {
            out.push(item);
        }
    }
    let hermes = home.join(".hermes");
    if let Some(item) = profile("hermes", "default", hermes.join("config.yaml")) {
        out.push(item);
    }
    if let Ok(profiles) = fs::read_dir(hermes.join("profiles")) {
        for entry in profiles.flatten().take(64) {
            if let Some(item) = profile(
                "hermes",
                &entry.file_name().to_string_lossy(),
                entry.path().join("config.yaml"),
            ) {
                out.push(item);
            }
        }
    }
    // Both integrations support named sibling homes; don't traverse arbitrary
    // files or walk projects from the daemon's cwd.
    if let Ok(entries) = fs::read_dir(home) {
        for entry in entries.flatten().take(256) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(label) = name.strip_prefix(".hermes-") {
                if !label.is_empty()
                    && entry.path().join("config.yaml").exists()
                    && let Some(item) = profile("hermes", label, entry.path().join("config.yaml"))
                {
                    out.push(item);
                }
            } else if name == ".openclaw" {
                if let Some(item) =
                    profile("openclaw", "default", entry.path().join("openclaw.json"))
                {
                    out.push(item);
                }
            } else if let Some(label) = name.strip_prefix(".openclaw-")
                && !label.is_empty()
                && entry.path().join("openclaw.json").exists()
                && let Some(item) = profile("openclaw", label, entry.path().join("openclaw.json"))
            {
                out.push(item);
            }
        }
    }
    out.sort_by(|a, b| (&a.integration, &a.settings_path).cmp(&(&b.integration, &b.settings_path)));
    out.truncate(64);
    out
}

fn new_instance_id() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(format!(
        "agt_{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}

pub fn read(path: &Path) -> io::Result<Option<AgentRoster>> {
    match fs::read(path) {
        Ok(bytes) => {
            let roster: AgentRoster = serde_json::from_slice(&bytes)
                .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
            if roster.schema_version != 1 || roster.generation == 0 || roster.agents.len() > 64 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "unsupported agent roster",
                ));
            }
            Ok(Some(roster))
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

fn write(path: &Path, roster: &AgentRoster) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("roster has no parent"))?;
    fs::create_dir_all(parent)?;
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    let bytes = serde_json::to_vec(roster).map_err(io::Error::other)?;
    let tmp = parent.join(format!(".roster-{}.tmp", new_instance_id()?));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        fs::remove_file(tmp).ok();
    }
    result
}

/// Refresh discovery without changing identities for existing config paths,
/// or for renamed profile directories with the same filesystem inode.
pub fn refresh(path: &Path, home: &Path) -> io::Result<AgentRoster> {
    let _guard = ROSTER_WRITE
        .lock()
        .map_err(|_| io::Error::other("agent roster lock poisoned"))?;
    refresh_unlocked(path, home)
}

fn refresh_unlocked(path: &Path, home: &Path) -> io::Result<AgentRoster> {
    let before = read(path)?;
    let previous = before
        .as_ref()
        .map(|r| r.agents.as_slice())
        .unwrap_or_default();
    let mut by_path = HashMap::new();
    let mut by_inode = HashMap::new();
    for entry in previous {
        by_path.insert((&entry.integration, &entry.settings_path), entry);
        if let Some(fingerprint) = &entry.fingerprint {
            by_inode.insert((&entry.integration, fingerprint), entry);
        }
    }
    let mut agents = profiles_at(home);
    let mut active_ids = HashSet::new();
    for entry in &mut agents {
        let old = by_path
            .get(&(&entry.integration, &entry.settings_path))
            .copied()
            .or_else(|| {
                entry
                    .fingerprint
                    .as_ref()
                    .and_then(|fp| by_inode.get(&(&entry.integration, fp)).copied())
            });
        entry.instance_id = match old {
            Some(old) if active_ids.insert(old.instance_id.clone()) => old.instance_id.clone(),
            _ => {
                let id = new_instance_id()?;
                active_ids.insert(id.clone());
                id
            }
        };
        entry.last_seen_at = old.and_then(|old| old.last_seen_at);
        entry.hook_installed |= old.is_some_and(|old| {
            old.hook_installed
                && old.last_seen_at.is_some_and(|at| {
                    current_millis().is_ok_and(|now| now.saturating_sub(at) < RECENT_SIGHTING_MS)
                })
        });
    }
    for old in previous {
        if agents.len() >= 64 {
            break;
        }
        if active_ids.insert(old.instance_id.clone()) {
            // Keep old names on the operator roster for historical
            // assignments. A project profile is found on hook-time sighting,
            // not by scanning arbitrary project directories; keep it hooked
            // while recently active, and otherwise mark it stale.
            let mut stale = old.clone();
            stale.hook_installed = old.hook_installed
                && old.last_seen_at.is_some_and(|at| {
                    current_millis().is_ok_and(|now| now.saturating_sub(at) < RECENT_SIGHTING_MS)
                })
                && Path::new(&old.settings_path)
                    .parent()
                    .is_some_and(Path::exists);
            agents.push(stale);
        }
    }
    agents.sort_by(|a, b| {
        (&a.integration, &a.settings_path).cmp(&(&b.integration, &b.settings_path))
    });
    let changed = before.as_ref().is_none_or(|r| r.agents != agents);
    let roster = AgentRoster {
        schema_version: 1,
        generation: before
            .as_ref()
            .map_or(1, |r| r.generation.saturating_add(u64::from(changed))),
        agents,
    };
    if changed {
        write(path, &roster)?;
    }
    Ok(roster)
}

fn current_millis() -> io::Result<i64> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?;
    i64::try_from(duration.as_millis()).map_err(io::Error::other)
}

/// A hook that actually reached this daemon is stronger evidence than a
/// settings file that merely mentions us. Only bounded, explicit config paths
/// enter the local roster. No project/transcript identifier is substituted.
pub fn record_sighting(
    path: &Path,
    home: &Path,
    integration: &str,
    settings_path: &Path,
) -> io::Result<()> {
    if !INTEGRATIONS.contains(&integration)
        || !settings_path.is_absolute()
        || settings_path.as_os_str().len() > 4096
        || settings_path
            .components()
            .any(|part| part == std::path::Component::ParentDir)
    {
        return Ok(());
    }
    let _guard = ROSTER_WRITE
        .lock()
        .map_err(|_| io::Error::other("agent roster lock poisoned"))?;
    let mut roster = match read(path)? {
        Some(roster) => roster,
        None => refresh_unlocked(path, home)?,
    };
    let settings = settings_path.to_string_lossy();
    let now = current_millis()?;
    let record = roster
        .agents
        .iter_mut()
        .find(|entry| entry.integration == integration && entry.settings_path == settings);
    if let Some(entry) = record {
        if entry.hook_installed
            && entry
                .last_seen_at
                .is_some_and(|at| now.saturating_sub(at) < 60_000)
        {
            return Ok(());
        }
        entry.hook_installed = true;
        entry.last_seen_at = Some(now);
    } else if roster.agents.len() < 64 {
        let label = settings_path
            .parent()
            .and_then(Path::file_name)
            .map(|name| safe_profile_label(&name.to_string_lossy()))
            .unwrap_or_else(|| "active".into());
        let Some(mut entry) = profile(integration, &label, settings_path.to_path_buf()) else {
            return Ok(());
        };
        entry.instance_id = new_instance_id()?;
        entry.hook_installed = true;
        entry.last_seen_at = Some(now);
        entry.scope = if matches!(integration, "hermes" | "openclaw")
            || profiles_at(home)
                .iter()
                .any(|known| known.integration == integration && known.settings_path == settings)
        {
            "user"
        } else {
            "project"
        }
        .into();
        roster.agents.push(entry);
        roster.agents.sort_by(|a, b| {
            (&a.integration, &a.settings_path).cmp(&(&b.integration, &b.settings_path))
        });
    } else {
        return Ok(());
    }
    roster.generation = roster.generation.saturating_add(1);
    write(path, &roster)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_ids_across_refresh_and_profile_rename() {
        let root = std::env::temp_dir().join(format!("fpai-roster-{}", new_instance_id().unwrap()));
        let home = root.join("home");
        let first = home.join(".hermes/profiles/work");
        fs::create_dir_all(&first).unwrap();
        fs::write(first.join("config.yaml"), "plugins: failproofai").unwrap();
        let path = root.join("fpai/agents/roster.json");
        let initial = refresh(&path, &home).unwrap();
        let work = initial
            .agents
            .iter()
            .find(|agent| agent.profile_label == "work")
            .unwrap();
        let id = work.instance_id.clone();
        assert_eq!(initial.generation, 1);
        assert!(work.hook_installed);
        assert_eq!(refresh(&path, &home).unwrap().generation, 1);
        fs::rename(&first, home.join(".hermes/profiles/renamed")).unwrap();
        let next = refresh(&path, &home).unwrap();
        assert_eq!(
            next.agents
                .iter()
                .find(|agent| agent.profile_label == "renamed")
                .unwrap()
                .instance_id,
            id
        );
        assert_eq!(next.generation, 2);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn hook_sighting_records_an_active_project_profile_without_leaking_paths_to_cloud() {
        let root = std::env::temp_dir().join(format!("fpai-roster-{}", new_instance_id().unwrap()));
        let home = root.join("home");
        let project = root.join("project/.codex");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&project).unwrap();
        let path = root.join("fpai/agents/roster.json");
        let settings = project.join("hooks.json");
        record_sighting(&path, &home, "codex", &settings).unwrap();
        let first = read(&path).unwrap().unwrap();
        assert_eq!(first.agents.len(), 1);
        assert_eq!(first.agents[0].scope, "project");
        assert!(first.agents[0].hook_installed);
        assert!(first.agents[0].last_seen_at.is_some());
        record_sighting(&path, &home, "codex", &settings).unwrap();
        assert_eq!(read(&path).unwrap().unwrap().generation, first.generation);
        assert!(
            refresh(&path, &home).unwrap().agents[0].hook_installed,
            "a recently active project profile is not in user-home discovery"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
