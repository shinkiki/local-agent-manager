//! C9-20: 원격 명령 한 줄을 앱이 이해하는 문법으로 읽고, **이해한 것만 다시 적어** 보낸다.
//!
//! # 왜 파서가 필요한가
//!
//! `ssh host <문자열>`은 그 문자열을 **원격 로그인 셸이 파싱한다**. 앱이 로컬 argv를
//! 조립한다는 사실은 원격에서 성립하지 않으므로, 예전 경로는 셸이 한 줄을 여러 명령으로
//! 가를 수 있는 글자를 통째로 거절했다(C9-14). 그 대가가 파이프였다 — `grep`은 되는데
//! `journalctl … | grep …`은 안 되니, 에이전트는 200줄을 다 받아 놓고 스스로 훑어야 했다.
//!
//! 글자 집합만 넓히는 것은 답이 아니다. 차단 목록은 명령 **앞머리** 대조라서, `ls; rm -rf /`
//! 는 `rm -rf` 규칙에 걸리지 않는다. 파이프를 열려면 한 줄을 단계로 갈라 **단계마다** 같은
//! 규칙을 걸 수 있어야 하고, 그러려면 앱이 그 줄의 문법을 알아야 한다.
//!
//! # 재조립이 신뢰 경계다
//!
//! 파싱한 원문을 그대로 보내면, 이 파서와 원격 셸(bash·dash·zsh)의 해석 차이가 그대로
//! 우회 경로가 된다. 그래서 여기서는 파싱 결과를 **앱이 다시 인용해 조립한 문자열**만
//! 내보낸다. 그러면 "앱이 이해한 것"과 "원격이 실행하는 것"이 같아지고, 파서가 모르는
//! 문법은 실행될 방법 자체가 없다. 영수증의 `command`도 이 정본이다.
//!
//! # 이해하는 문법
//!
//! 파이프(`|`), 리다이렉션(`>`·`>>`·`<`·`2>&1`), 인용(`'…'`·`"…"`), 글롭(`*`·`?`·`[…]`)까지다.
//! 거절하는 것은 명령을 **잇거나 새로 만드는** 문법이다 — `;`·`&&`·`||`·`&`, 명령 치환
//! (`$(…)`·백틱), 변수 확장(`$VAR`: 값이 앱에 보이지 않으면 어느 규칙도 판정할 수 없다),
//! 이스케이프(`\`), 그리고 `{}`·`()`. 파이프는 명령을 잇지 않는다 — 한 줄이 여전히 한 번의
//! 실행이고, 단계마다 정책을 걸 수 있다. 그것이 파이프만 여는 이유다.

use crate::CoreError;

/// 한 줄에 이을 수 있는 단계 수. 단계마다 정책 대조가 돌므로 상한이 있어야 한다.
pub(crate) const MAX_PIPELINE_STAGES: usize = 8;
/// 한 단계에 붙일 수 있는 리다이렉션 수.
const MAX_STAGE_REDIRECTS: usize = 4;

/// 따옴표 없이 적을 수 있는 글자. 재조립도 **같은 집합**을 쓴다 — 입력에서 맨몸으로 받은
/// 글자를 출력에서 따옴표로 감싸면 글롭이 죽고, 반대면 리터럴이 살아난다.
fn is_bare_char(character: char) -> bool {
    character.is_ascii_alphanumeric()
        || matches!(
            character,
            '-' | '_' | '.' | '/' | ':' | '=' | '@' | '+' | ',' | '%' | '~' | '*' | '?' | '[' | ']'
        )
}

/// 셸이 확장 의미로 읽는 글자. 따옴표 안에서 왔는지가 곧 의미라, 토큰마다 출처를 기억한다.
fn is_expansion_char(character: char) -> bool {
    matches!(character, '*' | '?' | '[' | ']' | '~')
}

/// 한 단어. `text`는 셸이 확장하기 **전의** 리터럴이고, `force_quote`는 따옴표 안에서 온
/// 확장 글자가 있어 맨몸으로 내보낼 수 없다는 표시다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Word {
    text: String,
    force_quote: bool,
}

impl Word {
    pub(crate) fn text(&self) -> &str {
        &self.text
    }

    /// 원격에 나갈 모양. 맨몸으로 낼 수 있으면 그대로 두고(글롭이 살아야 한다), 아니면
    /// 작은따옴표로 감싼다 — 그 안에서는 어떤 글자도 셸에게 의미를 갖지 않는다.
    fn render(&self) -> String {
        if !self.force_quote && !self.text.is_empty() && self.text.chars().all(is_bare_char) {
            return self.text.clone();
        }
        format!("'{}'", self.text.replace('\'', "'\\''"))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RedirectKind {
    /// `>` 덮어쓰기.
    Write,
    /// `>>` 이어 쓰기.
    Append,
    /// `<` 입력으로 읽기.
    Read,
    /// `2>&1` 처럼 다른 파이프로 합치기. 파일을 만들지 않는다.
    Merge,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum RedirectTarget {
    File(Word),
    Fd(u8),
}

/// 한 단계에 붙은 방향 바꾸기 하나.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RemoteRedirect {
    fd: u8,
    kind: RedirectKind,
    target: RedirectTarget,
}

impl RemoteRedirect {
    /// 파일을 만들거나 덮어쓰는 방향인지. 정책이 갈리는 자리는 여기 하나다.
    pub(crate) fn writes_file(&self) -> bool {
        matches!(self.kind, RedirectKind::Write | RedirectKind::Append)
    }

    fn render(&self) -> String {
        let default_fd = if matches!(self.kind, RedirectKind::Read) {
            0
        } else {
            1
        };
        let prefix = if self.fd == default_fd {
            String::new()
        } else {
            self.fd.to_string()
        };
        match (&self.kind, &self.target) {
            (RedirectKind::Write, RedirectTarget::File(word)) => {
                format!("{prefix}>{}", word.render())
            }
            (RedirectKind::Append, RedirectTarget::File(word)) => {
                format!("{prefix}>>{}", word.render())
            }
            (RedirectKind::Read, RedirectTarget::File(word)) => {
                format!("{prefix}<{}", word.render())
            }
            (RedirectKind::Merge, RedirectTarget::Fd(fd)) => format!("{prefix}>&{fd}"),
            // 만들 수 없는 짝이라 파서가 내보내지 않는다. 그래도 조용히 다른 뜻이 되지
            // 않도록, 실행될 수 없는 모양 대신 빈 문자열을 낸다.
            _ => String::new(),
        }
    }
}

/// 파이프라인의 한 단계. 정책은 이 단위로 걸린다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RemoteStage {
    argv: Vec<Word>,
    redirects: Vec<RemoteRedirect>,
}

impl RemoteStage {
    /// 정책 대조가 보는 단어들. 셸이 갈라 읽을 경계가 아니라 **앱이 정한 경계**다.
    pub(crate) fn argv(&self) -> Vec<&str> {
        self.argv.iter().map(Word::text).collect()
    }

    pub(crate) fn redirects(&self) -> &[RemoteRedirect] {
        &self.redirects
    }

    /// 이 단계의 명령만 다시 적은 줄. 허용 목록에 적을 규칙과 진단 문구가 같은 값을 쓴다 —
    /// 리다이렉션은 빠진다. 규칙은 명령 앞머리와 맞춰 보는 값이라 방향 바꾸기가 낄 자리가 없다.
    pub(crate) fn render_command(&self) -> String {
        self.argv
            .iter()
            .map(Word::render)
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn render(&self) -> String {
        let mut rendered = self.render_command();
        for redirect in &self.redirects {
            rendered.push(' ');
            rendered.push_str(&redirect.render());
        }
        rendered
    }
}

/// 원격에 보낼 한 줄 전체. 파서만 만들 수 있으므로, 이 타입을 들고 있다는 것은 곧 문법을
/// 이해했다는 뜻이다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RemoteCommandLine {
    stages: Vec<RemoteStage>,
}

impl RemoteCommandLine {
    pub(crate) fn stages(&self) -> &[RemoteStage] {
        &self.stages
    }

    /// C9-19. 주어진 자리의 `sudo` 바로 뒤에 `-S`를 끼운 사본. 이미 적혀 있으면 그대로 둔다.
    ///
    /// 자리를 밖에서 받는 것은 "어디가 sudo 호출인가"가 정책 판정
    /// ([`crate::ssh_command_policy::sudo_prompt_positions`])이기 때문이다 — 같은 앞머리
    /// 규칙을 두 벌로 적으면 한쪽만 고쳐진다. 끼우는 자리가 `sudo` 바로 뒤여야 하는 것은
    /// 그다음 토큰부터는 다시 명령이어서다(`sudo ls -S`의 `-S`는 `ls`의 플래그다).
    ///
    /// **이 사본은 원격에 나갈 때만 쓴다.** 영수증·승인 카드·감사 기록에 남는 줄은 사용자가
    /// 읽고 허용한 원본이다. `-S`는 "비밀번호를 stdin에서 읽어라"일 뿐 명령이 하는 일을
    /// 바꾸지 않으므로, 승인한 한 줄과 기록된 한 줄이 어긋나는 편이 더 나쁘다.
    pub(crate) fn with_stdin_password_flag(&self, positions: &[(usize, usize)]) -> Self {
        let mut stages = self.stages.clone();
        for (stage_index, token_index) in positions {
            let Some(stage) = stages.get_mut(*stage_index) else {
                continue;
            };
            // 이미 적혀 있는지는 **sudo 자신의 옵션 구간**에서만 본다. 단계 전체를 훑으면
            // 감싸인 명령의 `-S`(`ls -S`·`sort -S 1G`)가 sudo의 것으로 읽혀, sudo에는
            // `-S`가 붙지 않은 채 비밀번호만 stdin으로 나간다 — sudo는 tty가 없어 실패하고
            // 그 값은 원격 명령의 입력으로 흘러든다.
            let already_written = {
                let argv = stage.argv();
                crate::ssh_command_policy::sudo_own_options(&argv, *token_index).contains(&"-S")
            };
            if already_written {
                continue;
            }
            stage.argv.insert(
                token_index + 1,
                Word {
                    text: "-S".to_owned(),
                    force_quote: false,
                },
            );
        }
        Self { stages }
    }

    /// 원격에 실제로 나가는 정본. 영수증에 실리는 문자열도 이것이다.
    pub(crate) fn render(&self) -> String {
        self.stages
            .iter()
            .map(RemoteStage::render)
            .collect::<Vec<_>>()
            .join(" | ")
    }
}

/// 규칙 한 줄을 명령과 **같은 방식으로** 단어로 가른다. 규칙과 명령이 토큰 경계를 다르게
/// 읽으면, 사용자가 적은 `cat '/var/log/my app.log'`가 영원히 걸리지 않는 규칙이 된다.
///
/// 규칙은 명령이 아니므로 파이프·리다이렉션은 낄 수 없다. 옛 저장본에 그런 줄이 남아 있을
/// 수 있으니 호출하는 쪽이 실패를 공백 분할로 되돌린다.
pub(crate) fn parse_rule_words(value: &str) -> Result<Vec<String>, CoreError> {
    let line = parse_remote_command_line(value)?;
    let [stage] = line.stages() else {
        return Err(CoreError::InvalidInput(
            "규칙에는 파이프를 쓸 수 없습니다. 단계마다 한 줄씩 적으세요".to_owned(),
        ));
    };
    if !stage.redirects.is_empty() {
        return Err(CoreError::InvalidInput(
            "규칙에는 리다이렉션을 쓸 수 없습니다. 규칙은 명령 앞머리와만 맞춰 봅니다".to_owned(),
        ));
    }
    Ok(stage.argv.iter().map(|word| word.text.to_owned()).collect())
}

#[derive(Default)]
struct WordBuilder {
    text: String,
    started: bool,
    expansion_bare: bool,
    expansion_quoted: bool,
}

impl WordBuilder {
    fn push(&mut self, character: char, quoted: bool) {
        self.started = true;
        if is_expansion_char(character) {
            if quoted {
                self.expansion_quoted = true;
            } else {
                self.expansion_bare = true;
            }
        }
        self.text.push(character);
    }

    /// 따옴표 안에서 온 확장 글자가 있으면 통째로 감싸야 하고, 그러면 같은 단어 안의 맨몸
    /// 글롭도 같이 죽는다. 둘을 한 단어에 섞으면 어느 쪽으로 적어도 뜻이 달라지므로, 조용히
    /// 한쪽을 고르지 않고 거절한다.
    fn finish(&mut self) -> Result<Option<Word>, CoreError> {
        if !self.started {
            return Ok(None);
        }
        if self.expansion_quoted && self.expansion_bare {
            return Err(CoreError::InvalidInput(format!(
                "한 단어 안에서 글롭과 따옴표로 감싼 같은 글자를 섞을 수 없습니다: {}. 단어를 나누거나 한쪽으로 통일하세요",
                self.text
            )));
        }
        let word = Word {
            text: std::mem::take(&mut self.text),
            force_quote: self.expansion_quoted,
        };
        self.started = false;
        self.expansion_bare = false;
        self.expansion_quoted = false;
        Ok(Some(word))
    }

    /// 앞에 붙은 파일 서술자 숫자인지. `2>&1`의 `2`가 단어가 아니라 방향 표시인 자리다.
    fn take_fd(&mut self) -> Option<u8> {
        if self.expansion_bare || self.expansion_quoted {
            return None;
        }
        let fd = match self.text.as_str() {
            "0" => 0,
            "1" => 1,
            "2" => 2,
            _ => return None,
        };
        self.text.clear();
        self.started = false;
        Some(fd)
    }
}

struct PendingRedirect {
    fd: u8,
    kind: RedirectKind,
}

#[derive(Default)]
struct StageBuilder {
    argv: Vec<Word>,
    redirects: Vec<RemoteRedirect>,
}

impl StageBuilder {
    fn accept(
        &mut self,
        word: Word,
        pending: &mut Option<PendingRedirect>,
    ) -> Result<(), CoreError> {
        match pending.take() {
            Some(redirect) => {
                if self.redirects.len() >= MAX_STAGE_REDIRECTS {
                    return Err(CoreError::InvalidInput(format!(
                        "한 단계에 붙일 수 있는 리다이렉션은 {MAX_STAGE_REDIRECTS}개까지입니다"
                    )));
                }
                self.redirects.push(RemoteRedirect {
                    fd: redirect.fd,
                    kind: redirect.kind,
                    target: RedirectTarget::File(word),
                });
            }
            None => self.argv.push(word),
        }
        Ok(())
    }

    fn finish(&mut self, pending: &Option<PendingRedirect>) -> Result<RemoteStage, CoreError> {
        if pending.is_some() {
            return Err(CoreError::InvalidInput(
                "리다이렉션 뒤에 대상이 없습니다".to_owned(),
            ));
        }
        if self.argv.is_empty() {
            return Err(CoreError::InvalidInput(
                "파이프 사이에 실행할 명령이 없습니다".to_owned(),
            ));
        }
        Ok(RemoteStage {
            argv: std::mem::take(&mut self.argv),
            redirects: std::mem::take(&mut self.redirects),
        })
    }
}

fn refuse(what: &str) -> CoreError {
    CoreError::InvalidInput(format!(
        "{what} 이 경로는 파이프(|)·리다이렉션(>, >>, <, 2>&1)·인용·글롭만 이해하며, 명령을 잇거나 새로 만드는 문법은 읽지 않습니다. 여러 단계가 필요하면 단계마다 따로 요청하세요"
    ))
}

/// 한 줄을 훑는 커서. 아래 처리기들이 같은 커서를 이어 읽으므로, 한 조각을 읽고 남긴
/// 위치가 그대로 다음 조각의 시작이 된다.
type Scanner<'a> = std::iter::Peekable<std::str::Chars<'a>>;

/// 따옴표 한 쌍을 닫는 데까지 읽어 단어에 붙인다. 큰따옴표 안에서만 셸 치환을 거절한다 —
/// 값이 앱에 보이지 않으면 어떤 규칙도 판정할 수 없으므로, 리터럴이 필요하면 작은따옴표를
/// 쓰게 한다.
fn scan_quoted(
    characters: &mut Scanner<'_>,
    word: &mut WordBuilder,
    quote: char,
) -> Result<(), CoreError> {
    word.started = true;
    loop {
        let Some(inner) = characters.next() else {
            return Err(CoreError::InvalidInput(
                "따옴표가 닫히지 않았습니다".to_owned(),
            ));
        };
        if inner == quote {
            return Ok(());
        }
        if quote == '"' && matches!(inner, '$' | '`' | '\\') {
            return Err(refuse(&format!(
                "큰따옴표 안의 {inner:?}는 원격 셸이 치환으로 읽습니다. 글자 그대로 쓰려면 작은따옴표로 감싸세요."
            )));
        }
        word.push(inner, true);
    }
}

/// 파이프 하나에서 단계를 끊는다. 진행 중인 단어를 먼저 닫아 그 단계에 넣는다.
fn close_stage_at_pipe(
    characters: &mut Scanner<'_>,
    word: &mut WordBuilder,
    stage: &mut StageBuilder,
    pending: &mut Option<PendingRedirect>,
    stages: &mut Vec<RemoteStage>,
) -> Result<(), CoreError> {
    if characters.peek() == Some(&'|') {
        return Err(refuse("명령을 잇는 ||는 쓸 수 없습니다."));
    }
    if let Some(finished) = word.finish()? {
        stage.accept(finished, pending)?;
    }
    stages.push(stage.finish(pending)?);
    if stages.len() >= MAX_PIPELINE_STAGES {
        return Err(CoreError::InvalidInput(format!(
            "파이프라인은 {MAX_PIPELINE_STAGES}단계까지입니다"
        )));
    }
    Ok(())
}

/// `>`·`>>`·`<`·`2>&1` 한 조각을 읽는다. 대상 파일이 필요한 것은 다음 단어를 기다리도록
/// `pending`에 남기고, 파이프 번호를 합치는 `>&`만 그 자리에서 확정한다.
fn open_redirect(
    character: char,
    characters: &mut Scanner<'_>,
    word: &mut WordBuilder,
    stage: &mut StageBuilder,
    pending: &mut Option<PendingRedirect>,
) -> Result<(), CoreError> {
    let read = character == '<';
    let fd = word.take_fd();
    if let Some(finished) = word.finish()? {
        stage.accept(finished, pending)?;
    }
    if pending.is_some() {
        return Err(CoreError::InvalidInput(
            "리다이렉션 뒤에 대상이 없습니다".to_owned(),
        ));
    }
    if read {
        if characters.peek() == Some(&'<') {
            return Err(refuse("여기 문서(<<)는 쓸 수 없습니다."));
        }
        *pending = Some(PendingRedirect {
            fd: fd.unwrap_or(0),
            kind: RedirectKind::Read,
        });
        return Ok(());
    }
    let fd = fd.unwrap_or(1);
    match characters.peek() {
        Some('>') => {
            characters.next();
            *pending = Some(PendingRedirect {
                fd,
                kind: RedirectKind::Append,
            });
        }
        Some('&') => {
            characters.next();
            let target = match characters.next() {
                Some(digit @ ('0'..='2')) => digit as u8 - b'0',
                _ => {
                    return Err(refuse(
                        ">& 뒤에는 합칠 파이프 번호(0·1·2)만 올 수 있습니다.",
                    ))
                }
            };
            if !matches!(characters.peek(), None | Some(' ') | Some('\t') | Some('|')) {
                return Err(refuse(">& 뒤에는 파이프 번호 하나만 옵니다."));
            }
            if stage.redirects.len() >= MAX_STAGE_REDIRECTS {
                return Err(CoreError::InvalidInput(format!(
                    "한 단계에 붙일 수 있는 리다이렉션은 {MAX_STAGE_REDIRECTS}개까지입니다"
                )));
            }
            stage.redirects.push(RemoteRedirect {
                fd,
                kind: RedirectKind::Merge,
                target: RedirectTarget::Fd(target),
            });
        }
        _ => {
            *pending = Some(PendingRedirect {
                fd,
                kind: RedirectKind::Write,
            });
        }
    }
    Ok(())
}

/// 한 줄을 단계로 가른다. 이해하지 못한 글자는 하나도 지나가지 못하고, 돌려준 값은 그대로
/// 다시 적어 보낼 수 있다.
pub(crate) fn parse_remote_command_line(value: &str) -> Result<RemoteCommandLine, CoreError> {
    // 제어문자는 문법보다 먼저 거절한다. 줄바꿈이 공백처럼 지나가면 두 줄을 보낸 요청이
    // 조용히 한 명령의 인자로 바뀌어, 거절도 실행도 아닌 제3의 명령이 나간다.
    if let Some(character) = value.chars().find(|value| value.is_control()) {
        return Err(CoreError::InvalidInput(format!(
            "원격 명령에 제어문자가 있습니다: {character:?}. 이 경로는 한 줄짜리 명령만 실행합니다"
        )));
    }

    if value.trim().is_empty() {
        return Err(CoreError::InvalidInput(
            "실행할 원격 명령이 비어 있습니다".to_owned(),
        ));
    }

    let mut stages: Vec<RemoteStage> = Vec::new();
    let mut stage = StageBuilder::default();
    let mut word = WordBuilder::default();
    let mut pending: Option<PendingRedirect> = None;
    let mut characters = value.chars().peekable();

    while let Some(character) = characters.next() {
        match character {
            ' ' | '\t' => {
                if let Some(finished) = word.finish()? {
                    stage.accept(finished, &mut pending)?;
                }
            }
            '\'' | '"' => scan_quoted(&mut characters, &mut word, character)?,
            '|' => close_stage_at_pipe(
                &mut characters,
                &mut word,
                &mut stage,
                &mut pending,
                &mut stages,
            )?,
            '>' | '<' => open_redirect(
                character,
                &mut characters,
                &mut word,
                &mut stage,
                &mut pending,
            )?,
            ';' => return Err(refuse("명령을 잇는 ;는 쓸 수 없습니다.")),
            '&' => {
                return Err(refuse(
                    "명령을 잇거나 뒤로 보내는 &·&&는 쓸 수 없습니다.",
                ))
            }
            '$' | '`' => {
                return Err(refuse(
                    "명령 치환·변수 확장은 값이 앱에 보이지 않아 어떤 규칙도 판정할 수 없습니다.",
                ))
            }
            '(' | ')' | '{' | '}' => {
                return Err(refuse("부분 셸·묶음((), {})은 쓸 수 없습니다."))
            }
            '\\' => {
                return Err(refuse(
                    "역슬래시 이스케이프는 읽지 않습니다. 작은따옴표로 감싸세요.",
                ))
            }
            other if is_bare_char(other) => word.push(other, false),
            other => {
                return Err(CoreError::InvalidInput(format!(
                    "따옴표 없이 쓸 수 없는 글자입니다: {other:?}. 글자 그대로 넘기려면 작은따옴표로 감싸세요"
                )))
            }
        }
    }

    if let Some(finished) = word.finish()? {
        stage.accept(finished, &mut pending)?;
    }
    stages.push(stage.finish(&pending)?);
    Ok(RemoteCommandLine { stages })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(value: &str) -> String {
        parse_remote_command_line(value)
            .unwrap_or_else(|error| panic!("{value}: {error:?}"))
            .render()
    }

    fn refused(value: &str) -> String {
        match parse_remote_command_line(value) {
            Ok(line) => panic!("{value}가 지나갔습니다: {}", line.render()),
            Err(error) => error.to_string(),
        }
    }

    /// C9-20. 파이프라인은 단계로 갈리고, 단계마다 정책이 볼 단어가 나온다.
    #[test]
    fn pipelines_split_into_stages_with_their_own_words() {
        let line =
            parse_remote_command_line("journalctl -u app -n 200 | grep -i error | head -n 20")
                .expect("parse");
        assert_eq!(line.stages().len(), 3);
        assert_eq!(
            line.stages()[0].argv(),
            ["journalctl", "-u", "app", "-n", "200"]
        );
        assert_eq!(line.stages()[1].argv(), ["grep", "-i", "error"]);
        assert_eq!(line.stages()[2].render_command(), "head -n 20");
        // 정본은 앱이 다시 적은 줄이다. 공백이 접히고 단계 사이는 한 가지 모양으로 통일된다.
        assert_eq!(
            render("tail  -n   50 /var/log/app.log|grep ERROR"),
            "tail -n 50 /var/log/app.log | grep ERROR"
        );
    }

    /// 인용은 단어 경계로 살아남고, 재조립도 같은 경계를 지킨다. 정책이 보는 단어와 원격이
    /// 받는 단어가 같아야 규칙이 의미를 갖는다.
    #[test]
    fn quoted_words_survive_as_one_word_and_are_requoted() {
        let line = parse_remote_command_line("grep -i 'foo bar' /var/log/app.log").expect("parse");
        assert_eq!(
            line.stages()[0].argv(),
            ["grep", "-i", "foo bar", "/var/log/app.log"]
        );
        assert_eq!(line.render(), "grep -i 'foo bar' /var/log/app.log");
        // 따옴표가 필요 없는 단어는 따옴표 없이 돌아간다 — 안 그러면 글롭이 죽는다.
        assert_eq!(render("grep 'error' x"), "grep error x");
        // 작은따옴표 안에서는 무엇이든 글자 그대로다. 재조립도 같은 뜻을 유지한다.
        assert_eq!(render(r#"grep 'a$b;c' x"#), r#"grep 'a$b;c' x"#);
        // 작은따옴표를 인자에 담으려면 큰따옴표로 감싼다(역슬래시는 읽지 않는다). 정본은
        // 작은따옴표를 닫았다 다시 여는 POSIX 관용구로 다시 적는다.
        assert_eq!(render(r#"grep "it's" x"#), r#"grep 'it'\''s' x"#);
        // 큰따옴표는 경계로만 쓰이고, 치환이 낄 수 있는 글자는 그 안에서도 거절한다.
        assert_eq!(render(r#"grep -i "foo bar" x"#), "grep -i 'foo bar' x");
        assert!(refused(r#"echo "$HOME""#).contains("치환"));
    }

    /// 글롭은 맨몸으로 적었을 때만 살아 있고, 따옴표로 감싼 글롭 글자는 리터럴로 남는다.
    #[test]
    fn globs_stay_globs_only_when_they_arrived_bare() {
        assert_eq!(render("ls /srv/*.log"), "ls /srv/*.log");
        assert_eq!(render("grep '[0-9]+' x"), "grep '[0-9]+' x");
        assert_eq!(render("ls '*.log'"), "ls '*.log'");
        assert_eq!(render("ls ~/logs"), "ls ~/logs");
        assert_eq!(render("ls '~/logs'"), "ls '~/logs'");
        // 한 단어 안에 두 뜻을 섞으면 어느 쪽으로 적어도 뜻이 달라지므로 거절한다.
        assert!(refused("ls '*'.log*").contains("섞을 수 없습니다"));
    }

    /// 리다이렉션은 종류와 파이프 번호까지 읽고, 정본에서 같은 모양으로 다시 적힌다.
    #[test]
    fn redirections_are_parsed_with_their_descriptors() {
        let line = parse_remote_command_line("app --check > out.log 2>&1").expect("parse");
        let stage = &line.stages()[0];
        assert_eq!(stage.argv(), ["app", "--check"]);
        assert_eq!(stage.redirects().len(), 2);
        assert!(stage.redirects()[0].writes_file());
        assert!(!stage.redirects()[1].writes_file());
        assert_eq!(line.render(), "app --check >out.log 2>&1");
        assert_eq!(render("app >> out.log"), "app >>out.log");
        assert_eq!(render("sort < in.txt"), "sort <in.txt");
        assert_eq!(render("app 2> err.log"), "app 2>err.log");
        assert!(refused("cat << EOF").contains("여기 문서"));
        assert!(refused("app >").contains("대상이 없습니다"));
    }

    /// 명령을 잇거나 새로 만드는 문법은 하나도 지나가지 못한다. 파이프를 열어도 `ls; rm -rf /`
    /// 가 `rm -rf` 규칙을 피해 가는 일이 없어야 한다.
    #[test]
    fn command_joining_and_substitution_are_refused() {
        for value in [
            "ls; rm -rf /",
            "ls && rm -rf /",
            "ls || true",
            "ls &",
            "echo `id`",
            "echo $(id)",
            "echo $HOME",
            "ls (x)",
            "ls {a,b}",
            "ls \\; rm",
            "ls 'unterminated",
        ] {
            let message = refused(value);
            assert!(!message.is_empty(), "{value}");
        }
        // 제어문자와 빈 줄도 문법 앞에서 걸린다.
        assert!(refused("ls\nrm -rf /").contains("제어문자"));
        assert!(refused("   ").contains("비어 있습니다"));
        assert!(refused("ls | | wc").contains("명령이 없습니다"));
    }

    /// 단계 수에는 상한이 있다. 단계마다 정책 대조가 돌기 때문이다.
    #[test]
    fn pipeline_length_is_bounded() {
        let ok = ["ls"; MAX_PIPELINE_STAGES].join(" | ");
        assert_eq!(
            parse_remote_command_line(&ok)
                .expect("parse")
                .stages()
                .len(),
            MAX_PIPELINE_STAGES
        );
        let too_long = ["ls"; MAX_PIPELINE_STAGES + 1].join(" | ");
        assert!(refused(&too_long).contains("단계까지"));
    }

    /// 규칙은 명령과 같은 방식으로 갈린다. 파이프·리다이렉션은 규칙에 낄 수 없다.
    #[test]
    fn rules_tokenize_like_commands() {
        assert_eq!(
            parse_rule_words("cat ~/.ssh/id_").expect("rule"),
            ["cat", "~/.ssh/id_"]
        );
        assert_eq!(
            parse_rule_words("grep -i 'foo bar'").expect("rule"),
            ["grep", "-i", "foo bar"]
        );
        assert!(parse_rule_words("ls | wc").is_err());
        assert!(parse_rule_words("ls > x").is_err());
    }
}
