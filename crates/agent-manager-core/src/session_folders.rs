//! 세션 정리폴더 트리. 폴더 CRUD와 순서·단계·세션 수 계산을 한곳에 모아, 저장소
//! 파일 입출력(`store`)과 폴더 트리 규칙을 갈라 둔다. 공개 함수는 `store`가 그대로
//! 다시 내보내므로 호출부 경로(`store::create_session_folder` 등)는 그대로다.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::domain::SessionFolder;
use crate::store::{load_metadata, with_metadata, with_metadata_changed, AppMetadata};
use crate::CoreError;

/// 정리폴더 트리에서 허용하는 최대 단계. 최상위가 1단계이므로 5단계까지 중첩된다.
pub const MAX_SESSION_FOLDER_DEPTH: usize = 5;

pub fn list_session_folders(app_data_dir: &Path) -> Result<Vec<SessionFolder>, CoreError> {
    let metadata = load_metadata(app_data_dir)?;
    Ok(folders_with_counts(&metadata))
}

pub fn create_session_folder(
    app_data_dir: &Path,
    name: &str,
    color: &str,
    parent_id: Option<&str>,
) -> Result<SessionFolder, CoreError> {
    with_metadata(app_data_dir, |metadata| {
        let name = validate_folder_name(name)?;
        let color = validate_folder_color(color)?;
        let parent_id = match normalize_folder_reference(parent_id) {
            Some(parent_id) => {
                let parent_depth = folder_depth(&metadata.folders, parent_id)?;
                ensure_folder_depth_fits(parent_depth, 0)?;
                Some(parent_id.to_owned())
            }
            None => None,
        };
        let folder = SessionFolder {
            id: new_folder_id(metadata),
            name,
            color,
            sort_order: next_sibling_sort_order(&metadata.folders, parent_id.as_deref()),
            parent_id,
            hidden: false,
            depth: 0,
            session_count: 0,
            total_session_count: 0,
        };
        let id = folder.id.clone();
        metadata.folders.push(folder);
        folder_view(metadata, &id)
    })
}

/// `parent_id`가 `None`이면 상위 폴더를 그대로 두고, `Some(None)`이면 최상위로 올린다.
/// `hidden`이 `None`이면 숨김 여부를 그대로 둔다.
pub fn update_session_folder(
    app_data_dir: &Path,
    id: &str,
    name: Option<&str>,
    color: Option<&str>,
    parent_id: Option<Option<&str>>,
    hidden: Option<bool>,
) -> Result<SessionFolder, CoreError> {
    with_metadata(app_data_dir, |metadata| {
        ensure_folder_exists(&metadata.folders, id)?;
        let next_name = name.map(validate_folder_name).transpose()?;
        let next_color = color.map(validate_folder_color).transpose()?;
        let next_parent = match parent_id {
            None => None,
            Some(value) => Some(match normalize_folder_reference(value) {
                None => None,
                Some(parent_id) => {
                    if parent_id == id {
                        return Err(CoreError::InvalidInput(
                            "폴더를 자기 자신의 하위로 옮길 수 없습니다".to_owned(),
                        ));
                    }
                    let subtree = folder_subtree(&metadata.folders, id);
                    if subtree.ids.iter().any(|descendant| descendant == parent_id) {
                        return Err(CoreError::InvalidInput(
                            "폴더를 자기 하위 폴더 아래로 옮길 수 없습니다".to_owned(),
                        ));
                    }
                    let parent_depth = folder_depth(&metadata.folders, parent_id)?;
                    ensure_folder_depth_fits(parent_depth, subtree.height)?;
                    Some(parent_id.to_owned())
                }
            }),
        };
        // 다른 상위로 옮긴 폴더는 새 형제들 뒤에 붙여 원래 형제 순서와 섞이지 않게 한다.
        let current_parent = require_folder(&metadata.folders, id)?.parent_id.clone();
        let sort_order = match next_parent.as_ref() {
            Some(parent) if parent != &current_parent => Some(next_sibling_sort_order(
                &metadata.folders,
                parent.as_deref(),
            )),
            _ => None,
        };
        let folder = require_folder_mut(&mut metadata.folders, id)?;
        if let Some(name) = next_name {
            folder.name = name;
        }
        if let Some(color) = next_color {
            folder.color = color;
        }
        if let Some(parent) = next_parent {
            folder.parent_id = parent;
        }
        if let Some(hidden) = hidden {
            folder.hidden = hidden;
        }
        if let Some(sort_order) = sort_order {
            folder.sort_order = sort_order;
        }
        folder_view(metadata, id)
    })
}

/// 폴더를 형제 사이에서 옮기는 방향.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FolderMoveDirection {
    Up,
    Down,
}

impl FolderMoveDirection {
    pub const ALL: [Self; 2] = [Self::Up, Self::Down];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Up => "up",
            Self::Down => "down",
        }
    }

    /// 위로 이동하는 방향인지 여부.
    pub fn is_up(self) -> bool {
        matches!(self, Self::Up)
    }

    /// 아래로 이동하는 방향인지 여부.
    pub fn is_down(self) -> bool {
        matches!(self, Self::Down)
    }

    /// 형제 순서(sort_order) 계산 시 적용할 상대 증분(Up: -1, Down: +1).
    pub fn delta(self) -> i64 {
        match self {
            Self::Up => -1,
            Self::Down => 1,
        }
    }
}

impl std::fmt::Display for FolderMoveDirection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for FolderMoveDirection {
    type Err = CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "up" => Ok(Self::Up),
            "down" => Ok(Self::Down),
            _ => Err(CoreError::InvalidInput(format!(
                "알 수 없는 폴더 이동 방향입니다: {s}. up|down 중 하나를 쓰세요"
            ))),
        }
    }
}

/// 같은 상위를 가진 형제 폴더 사이에서 한 칸 위나 아래로 옮기고, 새 순서의 폴더
/// 목록을 트리 순서로 돌려준다. 끝이라 바꿀 형제가 없으면 목록만 그대로 돌려준다.
pub fn reorder_session_folder(
    app_data_dir: &Path,
    id: &str,
    direction: FolderMoveDirection,
) -> Result<Vec<SessionFolder>, CoreError> {
    with_metadata_changed(app_data_dir, |metadata| {
        ensure_folder_exists(&metadata.folders, id)?;
        // 화면과 같은 기준으로 정렬값을 다시 매긴 뒤 바꾼다. 옛 저장본은 정렬값이 겹칠
        // 수 있어, 그대로 더하고 빼면 한 칸 이동이 보이는 순서와 어긋난다.
        sanitize_folder_parents(&mut metadata.folders);
        normalize_sibling_sort_orders(&mut metadata.folders);
        let (parent_id, sort_order) = require_folder(&metadata.folders, id)
            .map(|folder| (folder.parent_id.clone(), folder.sort_order))?;
        let neighbor_order = sort_order + direction.delta();
        let neighbor = metadata.folders.iter().position(|folder| {
            folder.parent_id == parent_id && folder.sort_order == neighbor_order && folder.id != id
        });
        let Some(neighbor) = neighbor else {
            return Ok((false, folders_with_counts(metadata)));
        };
        metadata.folders[neighbor].sort_order = sort_order;
        require_folder_mut(&mut metadata.folders, id)?.sort_order = neighbor_order;
        Ok((true, folders_with_counts(metadata)))
    })
}

/// 폴더를 하위 트리째 지우고, 지워진 폴더 ID를 트리 순서로 돌려준다. 세션과 원본
/// 대화는 그대로 두고 폴더 배정만 없앤다.
pub fn delete_session_folder(app_data_dir: &Path, id: &str) -> Result<Vec<String>, CoreError> {
    with_metadata(app_data_dir, |metadata| {
        ensure_folder_exists(&metadata.folders, id)?;
        let mut removed = vec![id.to_owned()];
        removed.extend(folder_subtree(&metadata.folders, id).ids);
        metadata
            .folders
            .retain(|folder| !removed.contains(&folder.id));
        for session in metadata.sessions.values_mut() {
            session
                .folder_ids
                .retain(|folder_id| !removed.contains(folder_id));
        }
        Ok(removed)
    })
}

/// 세션 수·단계를 채운 폴더 목록을 트리 순서(부모 → 자식, 형제는 정렬순 → 이름순)로 만든다.
pub(crate) fn folders_with_counts(metadata: &AppMetadata) -> Vec<SessionFolder> {
    let mut folders = metadata.folders.clone();
    sanitize_folder_parents(&mut folders);

    let mut direct = HashMap::<&str, HashSet<&str>>::new();
    for (session_key, session) in &metadata.sessions {
        for folder_id in &session.folder_ids {
            direct
                .entry(folder_id.as_str())
                .or_default()
                .insert(session_key.as_str());
        }
    }

    let tree = FolderTree::build(&folders);

    // 하위 트리 합계는 잎에서 뿌리 방향으로 접어 올린다. 같은 세션이 여러 폴더에
    // 담겨 있어도 한 트리 안에서는 한 번만 센다. 숨긴 하위 폴더는 그 하위 트리째
    // 빼서, 상위 폴더 배지가 숨긴 세션을 다시 드러내지 않게 한다.
    let mut subtree = HashMap::<usize, HashSet<&str>>::new();
    for (index, _) in tree.ordered.iter().rev() {
        let mut sessions = direct
            .get(folders[*index].id.as_str())
            .cloned()
            .unwrap_or_default();
        for child in tree.children_of(&folders[*index].id) {
            if folders[*child].hidden {
                continue;
            }
            if let Some(child_sessions) = subtree.get(child) {
                sessions.extend(child_sessions.iter().copied());
            }
        }
        subtree.insert(*index, sessions);
    }

    tree.ordered
        .iter()
        .map(|(index, depth)| {
            let mut folder = folders[*index].clone();
            folder.depth = *depth;
            folder.session_count = direct
                .get(folder.id.as_str())
                .map(HashSet::len)
                .unwrap_or(0);
            folder.total_session_count = subtree.get(index).map(HashSet::len).unwrap_or(0);
            folder
        })
        .collect()
}

/// 형제 정렬을 적용해 한 번만 조립해 두는 폴더 트리. 색인은 `folders` 슬라이스의
/// 자리번호로 가리키므로, 만든 뒤 그 슬라이스의 길이나 차례를 바꾸면 안 된다.
struct FolderTree {
    /// 상위 폴더 ID → 형제 순서대로 늘어놓은 자식들의 자리번호.
    children: HashMap<String, Vec<usize>>,
    /// 부모가 자식보다 먼저 오는 방문 순서. `(자리번호, 최상위를 0으로 세는 단계)`.
    ordered: Vec<(usize, usize)>,
}

impl FolderTree {
    fn build(folders: &[SessionFolder]) -> Self {
        let mut children = HashMap::<String, Vec<usize>>::new();
        let mut roots = Vec::<usize>::new();
        for (index, folder) in folders.iter().enumerate() {
            match folder.parent_id.as_deref() {
                Some(parent) => children.entry(parent.to_owned()).or_default().push(index),
                None => roots.push(index),
            }
        }
        let sort_siblings = |siblings: &mut Vec<usize>| {
            siblings.sort_by(|left, right| sibling_order(&folders[*left], &folders[*right]));
        };
        sort_siblings(&mut roots);
        for siblings in children.values_mut() {
            sort_siblings(siblings);
        }

        let mut ordered = Vec::<(usize, usize)>::with_capacity(folders.len());
        let mut stack = roots
            .iter()
            .rev()
            .map(|index| (*index, 0usize))
            .collect::<Vec<_>>();
        while let Some((index, depth)) = stack.pop() {
            ordered.push((index, depth));
            if let Some(siblings) = children.get(folders[index].id.as_str()) {
                for child in siblings.iter().rev() {
                    stack.push((*child, depth + 1));
                }
            }
        }

        Self { children, ordered }
    }

    /// 상위 폴더 ID로 형제 순서대로 정렬된 자식 목록을 얻는다. 자식이 없으면 빈 조각이다.
    fn children_of(&self, parent_id: &str) -> &[usize] {
        self.children.get(parent_id).map_or(&[], Vec::as_slice)
    }
}

/// 화면이 형제 폴더를 늘어놓는 순서: 정렬값이 먼저고, 같으면 이름(대소문자 무시)이다.
/// 트리 조립과 정렬값 재부여가 같은 비교를 각자 펼쳐 두면 한쪽만 고쳐도 한 칸 이동이
/// 보이는 순서와 어긋나므로, 비교는 이 자리 하나만 둔다.
fn sibling_order(left: &SessionFolder, right: &SessionFolder) -> Ordering {
    left.sort_order
        .cmp(&right.sort_order)
        .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
}

fn folder_view(metadata: &AppMetadata, id: &str) -> Result<SessionFolder, CoreError> {
    folders_with_counts(metadata)
        .into_iter()
        .find(|folder| folder.id == id)
        .ok_or_else(folder_not_found)
}

/// 폴더 조회가 빈손일 때 화면이 받는 문구. 조회 지점마다 같은 문자열을 손으로 되풀이하면
/// 한 곳만 고쳐도 문구가 갈라지므로 만드는 자리를 하나만 둔다. 어떤 ID를 못 찾았는지
/// 함께 알리는 갈래(`folder_depth`·`update_session_meta`)는 문구가 다르므로 그대로 둔다.
fn folder_not_found() -> CoreError {
    CoreError::NotFound("세션 폴더를 찾을 수 없습니다".to_owned())
}

/// ID로 폴더 하나를 찾는다. 없으면 [`folder_not_found`]로 실패한다.
fn require_folder<'a>(
    folders: &'a [SessionFolder],
    id: &str,
) -> Result<&'a SessionFolder, CoreError> {
    folders
        .iter()
        .find(|folder| folder.id == id)
        .ok_or_else(folder_not_found)
}

/// 찾은 폴더를 그 자리에서 고쳐야 하는 호출부가 쓰는 갈래.
fn require_folder_mut<'a>(
    folders: &'a mut [SessionFolder],
    id: &str,
) -> Result<&'a mut SessionFolder, CoreError> {
    folders
        .iter_mut()
        .find(|folder| folder.id == id)
        .ok_or_else(folder_not_found)
}

/// 폴더가 있는지만 확인한다. 고치기에 앞서 대상 존재를 먼저 막아 세우는 호출부용.
fn ensure_folder_exists(folders: &[SessionFolder], id: &str) -> Result<(), CoreError> {
    require_folder(folders, id).map(|_| ())
}

fn normalize_folder_reference(value: Option<&str>) -> Option<&str> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "root")
}

/// 상위 폴더 단계와 옮길 하위 트리 높이를 더해 최대 단계를 넘지 않는지 확인한다.
fn ensure_folder_depth_fits(parent_depth: usize, subtree_height: usize) -> Result<(), CoreError> {
    if parent_depth + subtree_height + 2 > MAX_SESSION_FOLDER_DEPTH {
        return Err(CoreError::InvalidInput(format!(
            "폴더는 {MAX_SESSION_FOLDER_DEPTH}단계까지만 중첩할 수 있습니다"
        )));
    }
    Ok(())
}

/// 형제 그룹마다 보이는 순서(정렬값 → 이름)를 그대로 0부터 다시 매긴다. 정렬값이
/// 겹치거나 비어 있는 저장본도 한 칸 이동이 화면과 같게 동작하게 만든다.
fn normalize_sibling_sort_orders(folders: &mut [SessionFolder]) {
    let mut groups = HashMap::<Option<String>, Vec<usize>>::new();
    for (index, folder) in folders.iter().enumerate() {
        groups
            .entry(folder.parent_id.clone())
            .or_default()
            .push(index);
    }
    for mut siblings in groups.into_values() {
        siblings.sort_by(|left, right| sibling_order(&folders[*left], &folders[*right]));
        for (position, index) in siblings.into_iter().enumerate() {
            folders[index].sort_order = position as i64;
        }
    }
}

fn next_sibling_sort_order(folders: &[SessionFolder], parent_id: Option<&str>) -> i64 {
    folders
        .iter()
        .filter(|folder| folder.parent_id.as_deref() == parent_id)
        .map(|folder| folder.sort_order)
        .max()
        .unwrap_or(-1)
        + 1
}

/// 최상위를 0으로 세는 폴더 단계. 저장본이 깨져 순환이 남아 있어도 멈춘다.
fn folder_depth(folders: &[SessionFolder], id: &str) -> Result<usize, CoreError> {
    let mut cursor = folders
        .iter()
        .find(|folder| folder.id == id)
        .ok_or_else(|| CoreError::NotFound(format!("세션 폴더를 찾을 수 없습니다: {id}")))?;
    let mut depth = 0;
    while let Some(parent) = cursor.parent_id.as_deref() {
        let Some(parent) = folders.iter().find(|folder| folder.id == parent) else {
            break;
        };
        cursor = parent;
        depth += 1;
        if depth >= folders.len() {
            break;
        }
    }
    Ok(depth)
}

/// 폴더 하나의 하위 트리를 한 번 훑어 얻는 값.
struct FolderSubtree {
    /// 자신을 뺀 모든 하위 폴더 ID. 훑은 순서 그대로다.
    ids: Vec<String>,
    /// 이 폴더 아래로 몇 단계가 더 있는지. 하위가 없으면 0이다.
    height: usize,
}

/// 하위 폴더 ID와 하위 트리 높이를 한 번의 훑기로 함께 구한다.
///
/// 둘을 따로 구하던 때는 ID 모으기가 이미 모은 목록을 선형으로 뒤져 중복을 걸렀고
/// (폴더 수의 제곱), 높이는 단계마다 폴더 슬라이스를 처음부터 다시 걸러 냈다. 게다가
/// 높이 쪽은 재귀에 방문 기록이 없어 저장본에 상위 참조 순환이 남아 있으면 되돌아오지
/// 못했다. 상위 폴더별 자식 자리번호를 한 벌 모아 두고 방문한 폴더를 기억하며 훑으면
/// 세 문제가 함께 사라지고, 옮기기 검사처럼 둘을 다 쓰는 자리는 훑기 한 번으로 끝난다.
///
/// 훑는 차례는 예전 구현과 같다 — 자식은 슬라이스에 놓인 순서로 담고, 마지막에 담은
/// 폴더의 하위로 먼저 내려간다.
fn folder_subtree(folders: &[SessionFolder], id: &str) -> FolderSubtree {
    let mut children = HashMap::<&str, Vec<usize>>::new();
    for (index, folder) in folders.iter().enumerate() {
        if let Some(parent) = folder.parent_id.as_deref() {
            children.entry(parent).or_default().push(index);
        }
    }

    let mut ids = Vec::<String>::new();
    let mut visited = HashSet::from([id]);
    let mut height = 0;
    let mut frontier = vec![(id, 0usize)];
    while let Some((current, depth)) = frontier.pop() {
        for index in children.get(current).map_or(&[][..], Vec::as_slice) {
            let child = &folders[*index];
            if !visited.insert(child.id.as_str()) {
                continue;
            }
            ids.push(child.id.clone());
            height = height.max(depth + 1);
            frontier.push((child.id.as_str(), depth + 1));
        }
    }
    FolderSubtree { ids, height }
}

/// 저장본의 상위 폴더 참조가 사라졌거나 순환이면 최상위로 되돌려 트리를 항상 그릴 수 있게 한다.
fn sanitize_folder_parents(folders: &mut [SessionFolder]) {
    let known = folders
        .iter()
        .map(|folder| folder.id.clone())
        .collect::<HashSet<_>>();
    for folder in folders.iter_mut() {
        if let Some(parent) = folder.parent_id.as_deref() {
            if parent == folder.id || !known.contains(parent) {
                folder.parent_id = None;
            }
        }
    }
    let parents = folders
        .iter()
        .filter_map(|folder| {
            folder
                .parent_id
                .clone()
                .map(|parent| (folder.id.clone(), parent))
        })
        .collect::<HashMap<_, _>>();
    let cyclic = folders
        .iter()
        .filter(|folder| {
            let mut seen = HashSet::from([folder.id.clone()]);
            let mut cursor = folder.parent_id.clone();
            while let Some(current) = cursor {
                if !seen.insert(current.clone()) {
                    return true;
                }
                cursor = parents.get(&current).cloned();
            }
            false
        })
        .map(|folder| folder.id.clone())
        .collect::<HashSet<_>>();
    for folder in folders.iter_mut() {
        if cyclic.contains(&folder.id) {
            folder.parent_id = None;
        }
    }
}

fn validate_folder_name(value: &str) -> Result<String, CoreError> {
    let name = value.trim();
    if name.is_empty() {
        return Err(CoreError::InvalidInput("폴더 이름을 입력하세요".to_owned()));
    }
    if name.chars().count() > 80 {
        return Err(CoreError::InvalidInput(
            "폴더 이름은 80자 이하여야 합니다".to_owned(),
        ));
    }
    Ok(name.to_owned())
}

fn validate_folder_color(value: &str) -> Result<String, CoreError> {
    if value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        Ok(value.to_ascii_lowercase())
    } else {
        Err(CoreError::InvalidInput(
            "폴더 색상은 #RRGGBB 형식이어야 합니다".to_owned(),
        ))
    }
}

fn new_folder_id(metadata: &AppMetadata) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let mut suffix = metadata.folders.len();
    loop {
        let candidate = format!("folder-{nanos:x}-{suffix:x}");
        if metadata.folders.iter().all(|folder| folder.id != candidate) {
            return candidate;
        }
        suffix += 1;
    }
}
