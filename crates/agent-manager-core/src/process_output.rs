//! 자식 프로세스 출력 회수.
//!
//! 출력 상한을 넘겨도 끝까지 읽어 파이프가 막혀 자식이 멈추는 일을 막는다.

use std::io::Read;
use std::process::{ChildStderr, ChildStdout};
use std::thread;

pub(crate) const MAX_CAPTURED_OUTPUT_BYTES: usize = 256 * 1024;

/// 상한까지만 보관하고 나머지는 계속 읽어 버린다. 파이프가 막혀 자식이 멈추는 것을
/// 막으면서 메모리 사용은 제한한다.
pub(crate) fn read_capped(mut stream: impl Read) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut buffer = [0u8; 8 * 1024];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
            Ok(read) => append_capped_bytes(&mut kept, &buffer[..read], MAX_CAPTURED_OUTPUT_BYTES),
        }
    }
    kept
}

/// 이미 보관한 길이와 상한으로 이번 조각에서 남길 바이트 수를 정한다.
/// 상한을 이미 채웠으면 0이고, 그때 호출부는 빈 조각을 덧붙이게 된다.
fn room_for(kept_len: usize, chunk_len: usize, limit: usize) -> usize {
    limit.saturating_sub(kept_len).min(chunk_len)
}

/// 바이트 상한까지만 덧붙인다.
pub(crate) fn append_capped_bytes(kept: &mut Vec<u8>, chunk: &[u8], limit: usize) {
    let room = room_for(kept.len(), chunk.len(), limit);
    kept.extend_from_slice(&chunk[..room]);
}

/// 같은 상한 규칙을 문자열에 적용한다. 상한은 바이트라 남길 길이가 여러 바이트로 된
/// 글자 가운데를 가를 수 있으므로, 경계까지 물러선 뒤 덧붙인다. 물러설 자리가 없으면
/// 아무것도 붙이지 않는다.
pub(crate) fn append_capped_str(output: &mut String, chunk: &str, limit: usize) {
    let mut room = room_for(output.len(), chunk.len(), limit);
    while room > 0 && !chunk.is_char_boundary(room) {
        room -= 1;
    }
    output.push_str(&chunk[..room]);
}

/// stdout과 stderr를 동시에 끝까지 비워 자식 프로세스의 파이프 정체를 막는다.
pub(crate) struct CappedOutputReaders {
    stdout: thread::JoinHandle<Vec<u8>>,
    stderr: thread::JoinHandle<Vec<u8>>,
}

fn spawn_capped_reader(stream: Option<impl Read + Send + 'static>) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || stream.map(read_capped).unwrap_or_default())
}

fn finish_capped_reader(reader: thread::JoinHandle<Vec<u8>>) -> Vec<u8> {
    reader.join().unwrap_or_default()
}

impl CappedOutputReaders {
    pub(crate) fn spawn(stdout: Option<ChildStdout>, stderr: Option<ChildStderr>) -> Self {
        Self {
            stdout: spawn_capped_reader(stdout),
            stderr: spawn_capped_reader(stderr),
        }
    }

    pub(crate) fn finish(self) -> (Vec<u8>, Vec<u8>) {
        (
            finish_capped_reader(self.stdout),
            finish_capped_reader(self.stderr),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{ErrorKind, Read};

    #[test]
    fn read_capped_stops_keeping_bytes_at_the_limit() {
        let kept =
            read_capped(std::io::repeat(b'x').take((MAX_CAPTURED_OUTPUT_BYTES + 4096) as u64));
        assert_eq!(kept.len(), MAX_CAPTURED_OUTPUT_BYTES);
    }

    #[test]
    fn append_capped_str_backs_off_to_a_character_boundary() {
        let mut output = String::from("ab");
        // 상한까지 2바이트가 남았는데 다음 글자는 3바이트라, 한 글자도 붙지 않는다.
        append_capped_str(&mut output, "가나", 4);
        assert_eq!(output, "ab");
        append_capped_str(&mut output, "가나", 5);
        assert_eq!(output, "ab가");
    }

    #[test]
    fn append_capped_str_keeps_nothing_once_the_limit_is_reached() {
        let mut output = String::from("abcd");
        append_capped_str(&mut output, "efg", 2);
        assert_eq!(output, "abcd");
    }

    struct InterruptedReader<R> {
        inner: R,
        interrupted_once: bool,
    }

    impl<R: Read> Read for InterruptedReader<R> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if !self.interrupted_once {
                self.interrupted_once = true;
                return Err(std::io::Error::new(ErrorKind::Interrupted, "interrupted"));
            }
            self.inner.read(buf)
        }
    }

    #[test]
    fn read_capped_retries_on_interrupted_error() {
        let data = b"hello world";
        let reader = InterruptedReader {
            inner: &data[..],
            interrupted_once: false,
        };
        let kept = read_capped(reader);
        assert_eq!(kept, data);
    }

    #[test]
    fn finish_capped_reader_returns_the_thread_output() {
        let reader = thread::spawn(|| b"captured".to_vec());
        assert_eq!(finish_capped_reader(reader), b"captured");
    }

    #[test]
    fn finish_capped_reader_defaults_after_a_reader_panic() {
        let reader = thread::spawn(|| -> Vec<u8> { panic!("reader failed") });
        assert!(finish_capped_reader(reader).is_empty());
    }
}
