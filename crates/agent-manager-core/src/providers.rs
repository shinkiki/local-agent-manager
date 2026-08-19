use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use crate::domain::{AppStatus, DetectedResource, ProviderId, ProviderStatus};
use crate::CoreError;

const STATUS_SCHEMA_VERSION: u32 = 1;

struct ProviderSpec {
    id: ProviderId,
    display_name: &'static str,
    executable_names: &'static [&'static str],
    history_paths: &'static [&'static str],
}

const PROVIDERS: &[ProviderSpec] = &[
    ProviderSpec {
        id: ProviderId::Claude,
        display_name: "Claude Code",
        executable_names: &["claude"],
        history_paths: &[".claude/projects"],
    },
    ProviderSpec {
        id: ProviderId::Codex,
        display_name: "OpenAI Codex",
        executable_names: &["codex"],
        history_paths: &[".codex/state_5.sqlite", ".codex/sessions"],
    },
    ProviderSpec {
        id: ProviderId::Antigravity,
        display_name: "Google Antigravity",
        // `antigravity` is the IDE launcher. Starting it for a headless chat
        // opens the desktop IDE instead of producing a CLI response.
        executable_names: &["agy", "antigravity-cli"],
        history_paths: &[
            ".gemini/antigravity-cli/conversation_summaries.db",
            ".gemini/antigravity-cli/conversations",
            ".gemini/antigravity/conversations",
        ],
    },
];

#[derive(Debug, Clone)]
struct DetectionContext {
    home: PathBuf,
    search_dirs: Vec<PathBuf>,
    executable_extensions: Vec<OsString>,
}

impl DetectionContext {
    fn from_environment() -> Result<Self, CoreError> {
        let home = env::var_os("HOME")
            .or_else(|| env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
            .ok_or(CoreError::HomeDirectoryUnavailable)?;

        let mut search_dirs = env::var_os("PATH")
            .map(|value| env::split_paths(&value).collect::<Vec<_>>())
            .unwrap_or_default();

        search_dirs.extend(common_executable_dirs(&home));
        deduplicate_paths(&mut search_dirs);

        Ok(Self {
            home,
            search_dirs,
            executable_extensions: executable_extensions(),
        })
    }
}

pub fn inspect_local_environment() -> Result<AppStatus, CoreError> {
    let context = DetectionContext::from_environment()?;
    Ok(inspect_with_context(&context))
}

fn inspect_with_context(context: &DetectionContext) -> AppStatus {
    AppStatus {
        schema_version: STATUS_SCHEMA_VERSION,
        platform: env::consts::OS.to_owned(),
        architecture: env::consts::ARCH.to_owned(),
        providers: PROVIDERS
            .iter()
            .map(|spec| inspect_provider(spec, context))
            .collect(),
    }
}

fn inspect_provider(spec: &ProviderSpec, context: &DetectionContext) -> ProviderStatus {
    ProviderStatus {
        provider: spec.id,
        display_name: spec.display_name.to_owned(),
        cli: find_executable(spec.executable_names, context)
            .map(resource_from_path)
            .unwrap_or_else(DetectedResource::missing),
        history: spec
            .history_paths
            .iter()
            .map(|relative| context.home.join(relative))
            .find(|path| path.exists())
            .map(resource_from_path)
            .unwrap_or_else(DetectedResource::missing),
    }
}

fn resource_from_path(path: PathBuf) -> DetectedResource {
    let display_path = fs::canonicalize(&path).unwrap_or(path);
    DetectedResource::found(display_path.to_string_lossy().into_owned())
}

fn find_executable(names: &[&str], context: &DetectionContext) -> Option<PathBuf> {
    // Names are ordered by provider preference. Search every PATH directory for
    // the canonical binary before considering a legacy alias.
    for name in names {
        for directory in &context.search_dirs {
            for candidate in executable_candidates(directory, name, &context.executable_extensions)
            {
                if is_executable_file(&candidate) {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

pub(crate) fn resolve_named_executable(names: &[&str]) -> Result<PathBuf, CoreError> {
    let context = DetectionContext::from_environment()?;
    let path = find_executable(names, &context)
        .ok_or_else(|| CoreError::NotFound(format!("{} 실행 파일을 찾을 수 없습니다", names[0])))?;
    let path = fs::canonicalize(path)?;
    if !is_executable_file(&path) {
        return Err(CoreError::InvalidInput(format!(
            "{} 경로가 실행 파일이 아닙니다",
            names[0]
        )));
    }
    Ok(path)
}

fn executable_candidates(directory: &Path, name: &str, extensions: &[OsString]) -> Vec<PathBuf> {
    let direct = directory.join(name);
    if Path::new(name).extension().is_some() || extensions.is_empty() {
        return vec![direct];
    }

    // Windows npm shims include both an extensionless POSIX shell script and a
    // `.cmd` launcher. Prefer PATHEXT candidates so the shell script is not
    // mistaken for a native Win32 executable (OS error 193).
    let mut candidates = extensions
        .iter()
        .map(|extension| {
            let mut file_name = OsString::from(name);
            file_name.push(extension);
            directory.join(file_name)
        })
        .collect::<Vec<_>>();
    candidates.push(direct);
    candidates
}

fn executable_extensions() -> Vec<OsString> {
    if cfg!(windows) {
        env::var_os("PATHEXT")
            .map(|value| {
                value
                    .to_string_lossy()
                    .split(';')
                    .filter(|item| !item.is_empty())
                    .map(OsString::from)
                    .collect()
            })
            .unwrap_or_else(|| {
                [".COM", ".EXE", ".BAT", ".CMD"]
                    .into_iter()
                    .map(OsString::from)
                    .collect()
            })
    } else {
        Vec::new()
    }
}

fn common_executable_dirs(home: &Path) -> Vec<PathBuf> {
    let mut directories = vec![
        home.join(".local/bin"),
        home.join(".npm-global/bin"),
        home.join(".cargo/bin"),
    ];

    if cfg!(target_os = "macos") {
        directories.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/Applications/Tailscale.app/Contents/MacOS"),
        ]);
    }

    if cfg!(windows) {
        if let Some(app_data) = env::var_os("APPDATA") {
            directories.push(PathBuf::from(app_data).join("npm"));
        }
        if let Some(program_files) = env::var_os("ProgramFiles") {
            directories.push(PathBuf::from(program_files).join("Tailscale"));
        }
    }

    directories
}

fn deduplicate_paths(paths: &mut Vec<PathBuf>) {
    let mut seen = HashSet::new();
    paths.retain(|path| !path.as_os_str().is_empty() && seen.insert(path.clone()));
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temporary_directory() -> PathBuf {
        tempfile::Builder::new()
            .prefix("agent-manager-core-")
            .tempdir()
            .expect("temporary directory must be created")
            .keep()
    }

    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;

        fs::write(path, "#!/bin/sh\n").expect("fixture must be written");
        let mut permissions = fs::metadata(path)
            .expect("fixture metadata must exist")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).expect("fixture permissions must be set");
    }

    #[test]
    #[cfg(unix)]
    fn detects_cli_and_history_as_separate_resources() {
        let root = temporary_directory();
        let bin = root.join("bin");
        let home = root.join("home");
        fs::create_dir_all(&bin).expect("bin directory must be created");
        fs::create_dir_all(home.join(".codex/sessions"))
            .expect("history directory must be created");
        make_executable(&bin.join("codex"));

        let context = DetectionContext {
            home,
            search_dirs: vec![bin],
            executable_extensions: Vec::new(),
        };
        let status = inspect_with_context(&context);
        let codex = status
            .providers
            .iter()
            .find(|provider| provider.provider == ProviderId::Codex)
            .expect("Codex status must exist");

        assert!(codex.cli.detected);
        assert!(codex.history.detected);
        assert_ne!(codex.cli.path, codex.history.path);

        fs::remove_dir_all(root).expect("temporary directory must be removed");
    }

    #[test]
    #[cfg(unix)]
    fn detects_antigravity_cli_using_the_agy_binary_name() {
        let root = temporary_directory();
        let bin = root.join("bin");
        let home = root.join("home");
        fs::create_dir_all(&bin).expect("bin directory must be created");
        fs::create_dir_all(&home).expect("home directory must be created");
        make_executable(&bin.join("agy"));

        let context = DetectionContext {
            home,
            search_dirs: vec![bin],
            executable_extensions: Vec::new(),
        };
        let status = inspect_with_context(&context);
        let antigravity = status
            .providers
            .iter()
            .find(|provider| provider.provider == ProviderId::Antigravity)
            .expect("Antigravity status must exist");

        assert!(antigravity.cli.detected);
        assert!(antigravity
            .cli
            .path
            .as_deref()
            .is_some_and(|path| path.ends_with("/agy")));

        fs::remove_dir_all(root).expect("temporary directory must be removed");
    }

    #[test]
    fn reports_missing_resources_without_inventing_paths() {
        let root = temporary_directory();
        let context = DetectionContext {
            home: root.clone(),
            search_dirs: Vec::new(),
            executable_extensions: Vec::new(),
        };

        let status = inspect_with_context(&context);

        assert!(status.providers.iter().all(|provider| {
            !provider.cli.detected
                && provider.cli.path.is_none()
                && !provider.history.detected
                && provider.history.path.is_none()
        }));

        fs::remove_dir_all(root).expect("temporary directory must be removed");
    }

    #[test]
    #[cfg(windows)]
    fn detects_pathext_launcher_before_extensionless_npm_script() {
        let root = temporary_directory();
        let shell_script = root.join("agy");
        let cmd_launcher = root.join("agy.CMD");
        fs::write(&shell_script, "#!/bin/sh\n").expect("shell script fixture");
        fs::write(&cmd_launcher, "@echo off\r\n").expect("cmd launcher fixture");
        let context = DetectionContext {
            home: root.clone(),
            search_dirs: vec![root.clone()],
            executable_extensions: vec![OsString::from(".EXE"), OsString::from(".CMD")],
        };

        assert_eq!(find_executable(&["agy"], &context), Some(cmd_launcher));

        fs::remove_dir_all(root).expect("temporary directory must be removed");
    }

    #[test]
    #[cfg(windows)]
    fn antigravity_ide_launcher_is_not_detected_as_the_cli() {
        let root = temporary_directory();
        let ide_bin = root.join("ide");
        let cli_bin = root.join("cli");
        fs::create_dir_all(&ide_bin).expect("IDE bin directory");
        fs::create_dir_all(&cli_bin).expect("CLI bin directory");
        fs::write(ide_bin.join("antigravity.CMD"), "@echo off\r\n").expect("IDE launcher");
        fs::write(cli_bin.join("agy.EXE"), "fixture").expect("CLI fixture");
        let context = DetectionContext {
            home: root.clone(),
            search_dirs: vec![ide_bin, cli_bin.clone()],
            executable_extensions: vec![OsString::from(".EXE"), OsString::from(".CMD")],
        };

        let antigravity = inspect_with_context(&context)
            .providers
            .into_iter()
            .find(|provider| provider.provider == ProviderId::Antigravity)
            .expect("Antigravity status");
        let expected_cli = fs::canonicalize(cli_bin.join("agy.EXE")).expect("canonical CLI path");
        assert_eq!(
            antigravity.cli.path,
            Some(expected_cli.to_string_lossy().into_owned())
        );

        fs::remove_dir_all(root).expect("temporary directory must be removed");
    }
}
