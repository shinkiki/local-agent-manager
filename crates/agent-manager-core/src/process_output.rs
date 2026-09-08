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
            Ok(read) => {
                if kept.len() < MAX_CAPTURED_OUTPUT_BYTES {
                    let room = MAX_CAPTURED_OUTPUT_BYTES - kept.len();
                    kept.extend_from_slice(&buffer[..read.min(room)]);
                }
            }
        }
    }
    kept
}

/// stdout과 stderr를 동시에 끝까지 비워 자식 프로세스의 파이프 정체를 막는다.
pub(crate) struct CappedOutputReaders {
    stdout: thread::JoinHandle<Vec<u8>>,
    stderr: thread::JoinHandle<Vec<u8>>,
}

impl CappedOutputReaders {
    pub(crate) fn spawn(stdout: Option<ChildStdout>, stderr: Option<ChildStderr>) -> Self {
        Self {
            stdout: thread::spawn(move || stdout.map(read_capped).unwrap_or_default()),
            stderr: thread::spawn(move || stderr.map(read_capped).unwrap_or_default()),
        }
    }

    pub(crate) fn finish(self) -> (Vec<u8>, Vec<u8>) {
        (
            self.stdout.join().unwrap_or_default(),
            self.stderr.join().unwrap_or_default(),
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
}
