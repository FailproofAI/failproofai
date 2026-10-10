//! Daemon-owned inventory of agent installations and profiles on this OS
//! user's machine. Paths remain local; only opaque IDs and bounded labels
//! are sent to Cloud. No process-list guesses or telemetry project IDs.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

static ROSTER_WRITE: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
/// Per roster file, in memory only: hook sightings that arrived while the
/// roster was full, and whether a hooked profile is still waiting for an ID.
/// Always taken after `ROSTER_WRITE`, never before it.
static CAPACITY: LazyLock<Mutex<HashMap<PathBuf, Capacity>>> = LazyLock::new(Default::default);
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
/// Profiles one roster holds. FailproofAI Cloud (`MAX_MACHINE_AGENTS`) and the
/// hook reader (`src/hooks/agent-roster.ts`) refuse a larger roster.
pub const MAX_AGENTS: usize = 256;
/// The hook reader's file-size bound. A roster is never written past it, or
/// every hook would lose its identity at once. `profile` admits only paths of
/// at most `MAX_SETTINGS_PATH_BYTES` with no control characters, so even 256
/// worst-case entries (every byte JSON-escaped) stay under half of it.
const MAX_ROSTER_BYTES: usize = 4_000_000;
const MAX_SETTINGS_PATH_BYTES: usize = 4096;
const MAX_PENDING_SIGHTINGS: usize = 32;

#[derive(Default)]
struct Capacity {
    pending: VecDeque<Sighting>,
    wanted: bool,
    /// The roster generation at which asking Cloud freed nothing. Forced
    /// capacity reports stop until the roster changes; the heartbeat report
    /// still retries the reclaim.
    stalled: Option<u64>,
}

#[derive(Clone)]
struct Sighting {
    integration: String,
    settings_path: PathBuf,
    at: i64,
}

/// Roster IDs FailproofAI Cloud can no longer newly target: unhooked in the
/// snapshot it just acknowledged, and named by none of this machine's
/// assignments of any kind. Cloud accepts a new exact-profile target (deploy
/// or rollback) only for a profile it holds as hooked, and only a report
/// changes what it holds, so these stay unreferenced until the next report.
/// Built only from that report's response and spent in the same maintenance
/// tick, before anything else is reported.
pub struct Reclaimable(HashSet<String>);

impl Reclaimable {
    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn from_report(reported: &AgentRoster, protected: &HashSet<String>) -> Self {
        Self(
            reported
                .agents
                .iter()
                .filter(|agent| !agent.hook_installed && !protected.contains(&agent.instance_id))
                .map(|agent| agent.instance_id.clone())
                .collect(),
        )
    }
}

/// A hooked profile is waiting for a slot: every report answered for this
/// snapshot is followed by a reclaim in the same tick.
pub fn needs_capacity(path: &Path) -> bool {
    CAPACITY
        .lock()
        .is_ok_and(|state| state.get(path).is_some_and(|capacity| capacity.wanted))
}

/// Whether to report sooner than the heartbeat to ask Cloud for capacity: a
/// profile is waiting and asking at this roster generation has not yet failed.
pub fn should_force_capacity_report(path: &Path, generation: u64) -> bool {
    CAPACITY.lock().is_ok_and(|state| {
        state
            .get(path)
            .is_some_and(|capacity| capacity.wanted && capacity.stalled != Some(generation))
    })
}

/// Asking Cloud freed nothing at `generation`.
pub fn capacity_stalled(path: &Path, generation: u64) {
    if let Ok(mut state) = CAPACITY.lock() {
        state.entry(path.to_path_buf()).or_default().stalled = Some(generation);
    }
}

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
    let settings_path = settings.to_string_lossy().into_owned();
    if settings_path.len() > MAX_SETTINGS_PATH_BYTES || settings_path.contains(char::is_control) {
        return None;
    }
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
        settings_path,
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
    out
}

fn unused_instance_id(active: &mut HashSet<String>) -> io::Result<String> {
    loop {
        let id = new_instance_id()?;
        if active.insert(id.clone()) {
            return Ok(id);
        }
    }
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
            if bytes.len() > MAX_ROSTER_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "agent roster is too large",
                ));
            }
            let roster: AgentRoster = serde_json::from_slice(&bytes)
                .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
            if roster.schema_version != 1
                || roster.generation == 0
                || roster.agents.len() > MAX_AGENTS
            {
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
    if bytes.len() > MAX_ROSTER_BYTES || roster.agents.len() > MAX_AGENTS {
        return Err(io::Error::other(
            "agent roster would exceed the hook reader's bounds",
        ));
    }
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
    refresh_unlocked(path, home, None)
}

/// `refresh`, but a hooked profile waiting for a slot may take one from the
/// oldest entry `reclaimable` names that is still unhooked.
pub fn reclaim(path: &Path, home: &Path, reclaimable: &Reclaimable) -> io::Result<AgentRoster> {
    let _guard = ROSTER_WRITE
        .lock()
        .map_err(|_| io::Error::other("agent roster lock poisoned"))?;
    refresh_unlocked(path, home, Some(reclaimable))
}

fn refresh_unlocked(
    path: &Path,
    home: &Path,
    reclaimable: Option<&Reclaimable>,
) -> io::Result<AgentRoster> {
    let before = read(path)?;
    let previous = before
        .as_ref()
        .map(|r| r.agents.as_slice())
        .unwrap_or_default();
    // Match against the bounded discovery walk before imposing the 64-row
    // upload cap. Truncating discovered profiles first and filling from them
    // evicted an old exact-profile ID whenever an earlier-sorting config
    // appeared, even while that old profile's hook was still active.
    let mut discovered: Vec<Option<AgentProfile>> =
        profiles_at(home).into_iter().map(Some).collect();
    let user_paths = user_profile_paths(discovered.iter().flatten());
    let mut agents = Vec::with_capacity(MAX_AGENTS);
    let mut active_ids = HashSet::new();
    let mut matched_ids = HashSet::new();
    let exact_paths: HashSet<(&str, &str)> = previous
        .iter()
        .map(|entry| (entry.integration.as_str(), entry.settings_path.as_str()))
        .collect();
    let now = current_millis().ok();
    for old in previous {
        // Exact path wins over a matching directory inode; a copied or
        // hard-linked config must not steal another profile's stable ID.
        let match_at = discovered
            .iter()
            .position(|item| {
                item.as_ref().is_some_and(|candidate| {
                    candidate.integration == old.integration
                        && candidate.settings_path == old.settings_path
                })
            })
            .or_else(|| {
                old.fingerprint.as_ref().and_then(|fingerprint| {
                    discovered.iter().position(|item| {
                        item.as_ref().is_some_and(|candidate| {
                            candidate.integration == old.integration
                                && candidate.fingerprint.as_ref() == Some(fingerprint)
                                && !exact_paths.contains(&(
                                    candidate.integration.as_str(),
                                    candidate.settings_path.as_str(),
                                ))
                        })
                    })
                })
            });
        let recent = old.hook_installed
            && old.last_seen_at.is_some_and(|at| {
                now.is_some_and(|now| now.saturating_sub(at) < RECENT_SIGHTING_MS)
            });
        let mut entry = if let Some(index) = match_at {
            let mut candidate = discovered[index]
                .take()
                .expect("matched profile is present");
            candidate.last_seen_at = old.last_seen_at;
            candidate.hook_installed |= recent;
            candidate
        } else {
            // A project profile is learned from hook-time sightings, not by
            // traversing every project. Keep its identity even when stale:
            // an existing deployment may still name this exact ID.
            let mut stale = old.clone();
            stale.hook_installed = recent
                && Path::new(&old.settings_path)
                    .parent()
                    .is_some_and(Path::exists);
            stale
        };
        if active_ids.insert(old.instance_id.clone()) {
            entry.instance_id = old.instance_id.clone();
        } else {
            // Do not keep duplicate IDs in a corrupt roster.
            entry.instance_id = unused_instance_id(&mut active_ids)?;
        }
        if match_at.is_some() {
            matched_ids.insert(entry.instance_id.clone());
        }
        agents.push(entry);
    }

    // Declared before the lock so it drops after it: on ANY early return
    // from here on, the waiting sightings are put back and nothing is lost.
    let mut restore = RestoreWaiting { path, saved: None };
    let mut capacity = CAPACITY
        .lock()
        .map_err(|_| io::Error::other("agent roster capacity lock poisoned"))?;
    let state = capacity.entry(path.to_path_buf()).or_default();
    restore.saved = Some((state.pending.clone(), state.wanted));
    // Hooked newcomers: sightings that arrived while the roster was full,
    // then configs carrying our hook. A sighting stays attached to its
    // candidate until it is admitted: the config alone may not show our hook
    // (one installed by a plugin, say), and it would then never ask again.
    let mut hooked = Vec::new();
    for sighting in std::mem::take(&mut state.pending) {
        let settings = sighting.settings_path.to_string_lossy();
        let same = |entry: &AgentProfile| {
            entry.integration == sighting.integration && entry.settings_path == settings
        };
        if let Some(entry) = agents.iter_mut().find(|entry| same(entry)) {
            entry.hook_installed = true;
            entry.last_seen_at = entry.last_seen_at.max(Some(sighting.at));
            continue;
        }
        let candidate = match discovered
            .iter_mut()
            .find(|slot| slot.as_ref().is_some_and(&same))
        {
            Some(slot) => slot.take().map(|mut entry| {
                entry.hook_installed = true;
                entry.last_seen_at = entry.last_seen_at.max(Some(sighting.at));
                entry
            }),
            None => sighted_profile(
                &user_paths,
                &sighting.integration,
                &sighting.settings_path,
                sighting.at,
            ),
        };
        if let Some(entry) = candidate {
            hooked.push((Some(sighting), entry));
        }
    }
    let (found, unhooked): (Vec<_>, Vec<_>) = discovered
        .into_iter()
        .flatten()
        .partition(|candidate| candidate.hook_installed);
    hooked.extend(found.into_iter().map(|candidate| (None, candidate)));

    // Existing IDs are never evicted to make room, except one Cloud has just
    // confirmed no assignment names and cannot newly target (`Reclaimable`),
    // whose profile is still unhooked here. Not-rediscovered entries go first,
    // then the longest unseen. Only a HOOKED newcomer may claim such a slot:
    // an unhooked config would evict, be re-admitted and evict again.
    let shortfall = hooked
        .len()
        .saturating_sub(MAX_AGENTS.saturating_sub(agents.len()));
    if shortfall > 0
        && let Some(Reclaimable(reclaimable)) = reclaimable
    {
        let mut victims: Vec<(bool, i64, &str)> = agents
            .iter()
            .filter(|entry| !entry.hook_installed && reclaimable.contains(&entry.instance_id))
            .map(|entry| {
                (
                    matched_ids.contains(&entry.instance_id),
                    entry.last_seen_at.unwrap_or(i64::MIN),
                    entry.instance_id.as_str(),
                )
            })
            .collect();
        victims.sort_unstable();
        let evicted: HashSet<String> = victims
            .into_iter()
            .take(shortfall)
            .map(|(_, _, id)| id.to_owned())
            .collect();
        agents.retain(|entry| !evicted.contains(&entry.instance_id));
    }
    state.wanted = false;
    for (sighting, mut entry) in hooked {
        if agents.len() >= MAX_AGENTS {
            state.wanted = true;
            state.pending.extend(sighting);
            continue;
        }
        entry.instance_id = unused_instance_id(&mut active_ids)?;
        agents.push(entry);
    }
    for mut entry in unhooked {
        if agents.len() >= MAX_AGENTS {
            break;
        }
        entry.instance_id = unused_instance_id(&mut active_ids)?;
        agents.push(entry);
    }
    drop(capacity);
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
    restore.saved = None;
    Ok(roster)
}

/// Puts a refresh's waiting sightings back unless it completed.
struct RestoreWaiting<'a> {
    path: &'a Path,
    saved: Option<(VecDeque<Sighting>, bool)>,
}

impl Drop for RestoreWaiting<'_> {
    fn drop(&mut self) {
        if let Some((pending, wanted)) = self.saved.take()
            && let Ok(mut capacity) = CAPACITY.lock()
        {
            let state = capacity.entry(self.path.to_path_buf()).or_default();
            (state.pending, state.wanted) = (pending, wanted);
        }
    }
}

fn current_millis() -> io::Result<i64> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?;
    i64::try_from(duration.as_millis()).map_err(io::Error::other)
}

fn user_profile_paths<'a>(
    profiles: impl Iterator<Item = &'a AgentProfile>,
) -> HashSet<(String, String)> {
    profiles
        .map(|entry| (entry.integration.clone(), entry.settings_path.clone()))
        .collect()
}

/// The entry a hook sighting creates for a config the roster does not list.
/// `user_paths` is the user-home discovery (`profiles_at`).
fn sighted_profile(
    user_paths: &HashSet<(String, String)>,
    integration: &str,
    settings_path: &Path,
    at: i64,
) -> Option<AgentProfile> {
    let label = settings_path
        .parent()
        .and_then(Path::file_name)
        .map(|name| safe_profile_label(&name.to_string_lossy()))
        .unwrap_or_else(|| "active".into());
    let mut entry = profile(integration, &label, settings_path.to_path_buf())?;
    entry.hook_installed = true;
    entry.last_seen_at = Some(at);
    entry.scope = if matches!(integration, "hermes" | "openclaw")
        || user_paths.contains(&(integration.to_owned(), entry.settings_path.clone()))
    {
        "user"
    } else {
        "project"
    }
    .into();
    Some(entry)
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
        None => refresh_unlocked(path, home, None)?,
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
    } else if roster.agents.len() < MAX_AGENTS {
        let user_paths = user_profile_paths(profiles_at(home).iter());
        let Some(mut entry) = sighted_profile(&user_paths, integration, settings_path, now) else {
            return Ok(());
        };
        entry.instance_id = new_instance_id()?;
        roster.agents.push(entry);
        roster.agents.sort_by(|a, b| {
            (&a.integration, &a.settings_path).cmp(&(&b.integration, &b.settings_path))
        });
    } else {
        // Full: the maintenance tick admits it after Cloud confirms which IDs
        // no assignment can still need (`reclaim`). Nothing is evicted here.
        let mut capacity = CAPACITY
            .lock()
            .map_err(|_| io::Error::other("agent roster capacity lock poisoned"))?;
        let state = capacity.entry(path.to_path_buf()).or_default();
        if !state
            .pending
            .iter()
            .any(|seen| seen.integration == integration && seen.settings_path == settings_path)
        {
            if state.pending.len() >= MAX_PENDING_SIGHTINGS {
                state.pending.pop_front();
            }
            state.pending.push_back(Sighting {
                integration: integration.into(),
                settings_path: settings_path.to_path_buf(),
                at: now,
            });
        }
        state.wanted = true;
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

    #[test]
    fn full_roster_preserves_an_exact_target_when_an_earlier_profile_appears() {
        let root = std::env::temp_dir().join(format!("fpai-roster-{}", new_instance_id().unwrap()));
        let home = root.join("home");
        let path = root.join("fpai/agents/roster.json");
        fs::create_dir_all(&home).unwrap();
        let now = current_millis().unwrap();
        let mut prior = Vec::new();
        for index in 0..MAX_AGENTS as u32 {
            let settings = root.join(format!("projects/p{index:03}/.codex/hooks.json"));
            fs::create_dir_all(settings.parent().unwrap()).unwrap();
            prior.push(AgentProfile {
                instance_id: format!("agt_{index:032x}"),
                integration: "codex".into(),
                settings_path: settings.to_string_lossy().into_owned(),
                profile_label: format!("p{index:03}"),
                scope: "project".into(),
                hook_installed: true,
                last_seen_at: Some(now - 61_000),
                fingerprint: None,
            });
        }
        let assigned = prior[MAX_AGENTS - 1].clone();
        write(
            &path,
            &AgentRoster {
                schema_version: 1,
                generation: 1,
                agents: prior,
            },
        )
        .unwrap();

        let claude = home.join(".claude/settings.json");
        fs::create_dir_all(claude.parent().unwrap()).unwrap();
        fs::write(claude, "failproofai").unwrap();
        let refreshed = refresh(&path, &home).unwrap();
        assert_eq!(refreshed.agents.len(), MAX_AGENTS);
        assert_eq!(refreshed.generation, 1);
        assert!(
            refreshed
                .agents
                .iter()
                .all(|entry| entry.integration == "codex"),
            "a new earlier-sorting integration must wait for free capacity"
        );
        assert_eq!(
            refreshed
                .agents
                .iter()
                .find(|entry| entry.settings_path == assigned.settings_path)
                .unwrap()
                .instance_id,
            assigned.instance_id,
        );

        // The retained profile must still be found and refreshed at hook
        // time; the old implementation dropped it and refused the sighting
        // because the new discovery had filled the last slot.
        record_sighting(&path, &home, "codex", Path::new(&assigned.settings_path)).unwrap();
        let after_hook = read(&path).unwrap().unwrap();
        let target = after_hook
            .agents
            .iter()
            .find(|entry| entry.settings_path == assigned.settings_path)
            .unwrap();
        assert_eq!(target.instance_id, assigned.instance_id);
        assert!(target.hook_installed);
        assert!(target.last_seen_at.unwrap() >= now);
        fs::remove_dir_all(root).unwrap();
    }
    fn day() -> i64 {
        24 * 60 * 60 * 1000
    }

    /// A full roster of codex project profiles. Entry `i` was last seen
    /// `40 + MAX_AGENTS - i` days ago, so entry 0 is the oldest.
    fn full_roster(root: &Path, path: &Path, hooked_folders: bool) -> Vec<AgentProfile> {
        let now = current_millis().unwrap();
        let agents: Vec<_> = (0..MAX_AGENTS as u32)
            .map(|index| {
                let settings = root.join(format!("projects/p{index:03}/.codex/hooks.json"));
                if hooked_folders {
                    fs::create_dir_all(settings.parent().unwrap()).unwrap();
                }
                AgentProfile {
                    instance_id: format!("agt_{index:032x}"),
                    integration: "codex".into(),
                    settings_path: settings.to_string_lossy().into_owned(),
                    profile_label: format!("p{index:03}"),
                    scope: "project".into(),
                    hook_installed: true,
                    last_seen_at: Some(now - (40 + MAX_AGENTS as i64 - i64::from(index)) * day()),
                    fingerprint: None,
                }
            })
            .collect();
        write(
            path,
            &AgentRoster {
                schema_version: 1,
                generation: 1,
                agents: agents.clone(),
            },
        )
        .unwrap();
        agents
    }

    fn ids(roster: &AgentRoster) -> HashSet<String> {
        roster
            .agents
            .iter()
            .map(|entry| entry.instance_id.clone())
            .collect()
    }

    #[test]
    fn a_full_stale_roster_admits_a_new_profile_and_keeps_every_assigned_id() {
        let root = std::env::temp_dir().join(format!("fpai-roster-{}", new_instance_id().unwrap()));
        let home = root.join("home");
        let path = root.join("fpai/agents/roster.json");
        fs::create_dir_all(&home).unwrap();
        let prior = full_roster(&root, &path, false);
        // Thirty days unseen and their folders gone: no longer hooked.
        let reported = refresh(&path, &home).unwrap();
        assert!(reported.agents.iter().all(|entry| !entry.hook_installed));
        assert_eq!(reported.agents.len(), MAX_AGENTS);

        // A newly installed project profile fires its hook on a full roster.
        let fresh = root.join("new-project/.claude/settings.json");
        fs::create_dir_all(fresh.parent().unwrap()).unwrap();
        record_sighting(&path, &home, "claude", &fresh).unwrap();
        assert_eq!(
            read(&path).unwrap().unwrap(),
            reported,
            "nothing evicted at hook time"
        );
        assert!(needs_capacity(&path));

        // The two OLDEST profiles are named by exact-profile assignments.
        let protected: HashSet<String> = [&prior[0], &prior[1]]
            .iter()
            .map(|entry| entry.instance_id.clone())
            .collect();
        let after = reclaim(
            &path,
            &home,
            &Reclaimable::from_report(&reported, &protected),
        )
        .unwrap();
        assert_eq!(after.agents.len(), MAX_AGENTS);
        assert!(after.generation > reported.generation);
        let admitted = after
            .agents
            .iter()
            .find(|entry| entry.settings_path == fresh.to_string_lossy())
            .expect("the new profile has an identity");
        assert_eq!(admitted.integration, "claude");
        assert_eq!(admitted.scope, "project");
        assert!(admitted.hook_installed);
        assert!(!ids(&reported).contains(&admitted.instance_id));
        let kept = ids(&after);
        assert!(protected.is_subset(&kept), "assigned IDs stay stable");
        let evicted: Vec<_> = ids(&reported).difference(&kept).cloned().collect();
        assert_eq!(
            evicted,
            vec![prior[2].instance_id.clone()],
            "oldest unassigned only"
        );
        assert!(!needs_capacity(&path));
        assert_eq!(
            refresh(&path, &home).unwrap(),
            after,
            "stable once admitted"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_full_roster_never_reclaims_without_cloud_or_an_id_cloud_might_target() {
        let root = std::env::temp_dir().join(format!("fpai-roster-{}", new_instance_id().unwrap()));
        let home = root.join("home");
        let path = root.join("fpai/agents/roster.json");
        fs::create_dir_all(&home).unwrap();
        let prior = full_roster(&root, &path, false);
        let unhooked = refresh(&path, &home).unwrap();
        let claude = home.join(".claude/settings.json");
        fs::create_dir_all(claude.parent().unwrap()).unwrap();
        fs::write(&claude, "failproofai").unwrap();

        // No report from Cloud: the hooked config waits, nothing moves.
        let waiting = refresh(&path, &home).unwrap();
        assert_eq!(waiting, unhooked);
        assert!(needs_capacity(&path));

        // Cloud last acknowledged every entry as hooked (or protects it):
        // any of them could be targeted again, so none may be reclaimed even
        // though this machine now sees them all unhooked.
        let mut acknowledged = unhooked.clone();
        for entry in &mut acknowledged.agents {
            entry.hook_installed = true;
        }
        acknowledged.agents[0].hook_installed = false;
        let protected = HashSet::from([prior[0].instance_id.clone()]);
        let after = reclaim(
            &path,
            &home,
            &Reclaimable::from_report(&acknowledged, &protected),
        )
        .unwrap();
        assert_eq!(after, unhooked);
        assert!(needs_capacity(&path));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn neither_an_unhooked_config_nor_a_hooked_entry_is_traded_for_a_slot() {
        let root = std::env::temp_dir().join(format!("fpai-roster-{}", new_instance_id().unwrap()));
        let home = root.join("home");
        let path = root.join("fpai/agents/roster.json");
        fs::create_dir_all(&home).unwrap();
        let prior = full_roster(&root, &path, false);
        let reported = refresh(&path, &home).unwrap();
        let everything = Reclaimable::from_report(&reported, &HashSet::new());

        // A config without our hook only ever takes a free slot; otherwise
        // it would evict, be re-admitted, and evict again every refresh.
        let cursor = home.join(".cursor/hooks.json");
        fs::create_dir_all(cursor.parent().unwrap()).unwrap();
        fs::write(&cursor, "{}").unwrap();
        assert_eq!(reclaim(&path, &home, &everything).unwrap(), reported);
        assert!(!needs_capacity(&path));

        // An entry whose hook fired since the report is not reclaimable.
        let busy = Path::new(&prior[0].settings_path);
        fs::create_dir_all(busy.parent().unwrap()).unwrap();
        record_sighting(&path, &home, "codex", busy).unwrap();
        let sighted = root.join("other/.codex/hooks.json");
        fs::create_dir_all(sighted.parent().unwrap()).unwrap();
        record_sighting(&path, &home, "codex", &sighted).unwrap();
        let after = reclaim(&path, &home, &everything).unwrap();
        let kept = ids(&after);
        assert!(
            kept.contains(&prior[0].instance_id),
            "a live hook keeps its ID"
        );
        assert!(
            !kept.contains(&prior[1].instance_id),
            "next oldest goes instead"
        );
        assert!(
            after
                .agents
                .iter()
                .any(|entry| entry.settings_path == sighted.to_string_lossy())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_hook_on_an_unadmitted_config_keeps_waiting_until_it_gets_a_slot() {
        let root = std::env::temp_dir().join(format!("fpai-roster-{}", new_instance_id().unwrap()));
        let home = root.join("home");
        let path = root.join("fpai/agents/roster.json");
        fs::create_dir_all(&home).unwrap();
        full_roster(&root, &path, false);
        let reported = refresh(&path, &home).unwrap();
        // The config does not name us (a plugin installed the hook), so
        // discovery alone never treats it as hooked.
        let settings = home.join(".claude/settings.json");
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        fs::write(&settings, "{}").unwrap();
        record_sighting(&path, &home, "claude", &settings).unwrap();
        assert!(needs_capacity(&path));
        // Every maintenance tick starts with a plain refresh. It must not
        // consume the sighting while the profile still has no slot.
        assert_eq!(refresh(&path, &home).unwrap(), reported);
        assert!(needs_capacity(&path));
        let after = reclaim(
            &path,
            &home,
            &Reclaimable::from_report(&reported, &HashSet::new()),
        )
        .unwrap();
        let admitted = after
            .agents
            .iter()
            .find(|entry| entry.settings_path == settings.to_string_lossy())
            .expect("the sighted profile has an identity");
        assert_eq!(
            (admitted.integration.as_str(), admitted.scope.as_str()),
            ("claude", "user")
        );
        assert!(admitted.hook_installed);
        assert!(!needs_capacity(&path));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn profiles_that_could_outgrow_the_hook_readers_bound_are_never_admitted() {
        let root = std::env::temp_dir().join(format!("fpai-roster-{}", new_instance_id().unwrap()));
        let home = root.join("home");
        let path = root.join("fpai/agents/roster.json");
        let control = root.join("bad\nname/.codex/hooks.json");
        fs::create_dir_all(control.parent().unwrap()).unwrap();
        fs::create_dir_all(&home).unwrap();
        record_sighting(&path, &home, "codex", &control).unwrap();
        assert!(
            read(&path)
                .unwrap()
                .is_none_or(|roster| roster.agents.is_empty())
        );
        // 256 entries of the largest admissible path, every byte escaped.
        let quoted = format!("/{}", "\"".repeat(MAX_SETTINGS_PATH_BYTES - 1));
        let worst = AgentRoster {
            schema_version: 1,
            generation: 1,
            agents: (0..MAX_AGENTS as u32)
                .map(|index| AgentProfile {
                    instance_id: format!("agt_{index:032x}"),
                    integration: "antigravity".into(),
                    settings_path: quoted.clone(),
                    profile_label: "\"".repeat(80),
                    scope: "project".into(),
                    hook_installed: true,
                    last_seen_at: Some(i64::MAX),
                    fingerprint: Some(format!("{}:{}", u64::MAX, u64::MAX)),
                })
                .collect(),
        };
        assert!(serde_json::to_vec(&worst).unwrap().len() < MAX_ROSTER_BYTES);
        fs::remove_dir_all(root).unwrap();
    }
}
