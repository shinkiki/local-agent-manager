//! Linux directory notifications avoid repeated tree scans while a source is idle.
//! G10: only bounded, canonical, non-symlink directories inside the registered root are watched.
use crate::CoreError;
use std::path::Path;

#[cfg(target_os = "linux")]
use {
    super::{allowed_name, invalid, validate_root, validate_root_path, MAX_SCAN},
    std::{
        collections::{BTreeMap, BTreeSet},
        ffi::CString,
        fs::{self, File},
        io::{ErrorKind, Read},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::ffi::OsStrExt,
        },
        path::PathBuf,
    },
};

#[cfg(target_os = "linux")]
pub(super) struct NativeWatch {
    file: File,
    directories: BTreeMap<PathBuf, i32>,
}

#[cfg(target_os = "linux")]
const _: () = assert!(std::mem::size_of::<libc::inotify_event>() == 16);

#[cfg(target_os = "linux")]
impl NativeWatch {
    pub(super) fn create(app: &Path, root: &str) -> Result<Self, CoreError> {
        // SAFETY: no pointers; the successful descriptor is owned exactly once below.
        let descriptor = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
        if descriptor < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        // SAFETY: descriptor is a newly allocated, valid fd and is not owned elsewhere.
        let mut watch = Self {
            file: unsafe { File::from_raw_fd(descriptor) },
            directories: BTreeMap::new(),
        };
        watch.sync(app, root)?;
        Ok(watch)
    }

    pub(super) fn sync(&mut self, app: &Path, raw: &str) -> Result<(), CoreError> {
        let root = validate_root(app, raw)?;
        let mut queue = vec![root.clone()];
        let mut next = BTreeMap::new();
        let mut scanned = 0;
        let mask = libc::IN_MODIFY
            | libc::IN_ATTRIB
            | libc::IN_CLOSE_WRITE
            | libc::IN_CREATE
            | libc::IN_DELETE
            | libc::IN_DELETE_SELF
            | libc::IN_MOVE_SELF
            | libc::IN_MOVED_FROM
            | libc::IN_MOVED_TO
            | libc::IN_ONLYDIR
            | libc::IN_DONT_FOLLOW;
        while let Some(path) = queue.pop() {
            let canonical = validate_root_path(app, &path)?;
            if !canonical.starts_with(&root) {
                return Err(invalid("인덱스 폴더 밖 경로입니다"));
            }
            if next.len() >= 1_024 {
                return Err(invalid(
                    "네이티브 감시 상한: 메타데이터 확인으로 전환합니다",
                ));
            }
            let c_path = CString::new(canonical.as_os_str().as_bytes())
                .map_err(|_| invalid("올바른 폴더 경로가 필요합니다"))?;
            // SAFETY: fd stays open; c_path is NUL-terminated and lives through this call.
            let id =
                unsafe { libc::inotify_add_watch(self.file.as_raw_fd(), c_path.as_ptr(), mask) };
            if id < 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            next.insert(canonical, id);
            for entry in fs::read_dir(&path)? {
                scanned += 1;
                if scanned > MAX_SCAN {
                    return Err(invalid("감시 탐색 상한: 메타데이터 확인으로 전환합니다"));
                }
                let entry = entry?;
                let kind = entry.file_type()?;
                if kind.is_dir()
                    && !kind.is_symlink()
                    && entry
                        .file_name()
                        .to_str()
                        .is_some_and(|name| allowed_name(name, true))
                {
                    queue.push(entry.path());
                }
            }
        }
        let ids: BTreeSet<_> = next.values().copied().collect();
        for id in self.directories.values().filter(|id| !ids.contains(id)) {
            // SAFETY: the fd is valid. An already removed watch may return EINVAL; it is gone either way.
            unsafe {
                libc::inotify_rm_watch(self.file.as_raw_fd(), *id);
            }
        }
        self.directories = next;
        Ok(())
    }

    pub(super) fn changed(&mut self) -> std::io::Result<bool> {
        let mut buffer = [0_u8; 16_384];
        let mut changed = false;
        // Bound draining even when an external build continuously modifies source files.
        for _ in 0..64 {
            let count = match self.file.read(&mut buffer) {
                Ok(0) => return Err(std::io::Error::from(ErrorKind::UnexpectedEof)),
                Ok(count) => count,
                Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            };
            let mut position = 0;
            while position + 16 <= count {
                // The kernel ABI header is four native-endian 32-bit fields. Decode bytes
                // rather than constructing an unaligned inotify_event reference.
                let mask =
                    u32::from_ne_bytes(buffer[position + 4..position + 8].try_into().unwrap());
                let length =
                    u32::from_ne_bytes(buffer[position + 12..position + 16].try_into().unwrap())
                        as usize;
                if length > count - position - 16 {
                    return Err(std::io::Error::from(ErrorKind::InvalidData));
                }
                changed |= mask != 0;
                position += 16 + length;
            }
            if position != count {
                return Err(std::io::Error::from(ErrorKind::InvalidData));
            }
        }
        Ok(changed)
    }
}

#[cfg(not(target_os = "linux"))]
pub(super) struct NativeWatch;
#[cfg(not(target_os = "linux"))]
impl NativeWatch {
    pub(super) fn create(_: &Path, _: &str) -> Result<Self, CoreError> {
        Err(super::invalid("메타데이터 파일 감시를 사용합니다"))
    }
    pub(super) fn sync(&mut self, _: &Path, _: &str) -> Result<(), CoreError> {
        Ok(())
    }
    pub(super) fn changed(&mut self) -> std::io::Result<bool> {
        Ok(false)
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    /// G10/G7: resync must retire watches that moved outside the source, even when
    /// a replacement tree now occupies the same paths and a symlink points back out.
    #[test]
    fn g10_sync_detaches_moved_directories_and_watches_their_replacements() {
        let temp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(temp.path()).unwrap();
        let app = base.join("app");
        let root = base.join("source");
        let nested = root.join("nested/child");
        fs::create_dir(&app).unwrap();
        fs::create_dir_all(&nested).unwrap();
        let raw = root.to_str().unwrap();
        let mut watch = NativeWatch::create(&app, raw).unwrap();
        assert!(!watch.changed().unwrap());

        fs::write(nested.join("note.md"), "original").unwrap();
        assert!(watch.changed().unwrap(), "the original subtree is watched");
        assert!(!watch.changed().unwrap());

        let detached = base.join("detached");
        fs::rename(root.join("nested"), &detached).unwrap();
        assert!(
            watch.changed().unwrap(),
            "moving the subtree queues a refresh"
        );
        fs::create_dir_all(&nested).unwrap();
        std::os::unix::fs::symlink(&detached, root.join("linked")).unwrap();
        watch.sync(&app, raw).unwrap();
        // Drain creation and IN_IGNORED events before observing subsequent writes.
        watch.changed().unwrap();
        assert!(!watch.changed().unwrap());

        fs::write(detached.join("note.md"), "outside parent").unwrap();
        fs::write(detached.join("child/note.md"), "outside child").unwrap();
        assert!(
            !watch.changed().unwrap(),
            "neither the moved subtree nor the outward symlink remains watched"
        );
        fs::write(nested.join("note.md"), "replacement").unwrap();
        assert!(
            watch.changed().unwrap(),
            "the replacement subtree is watched"
        );
        assert!(!watch.changed().unwrap());
    }
}
