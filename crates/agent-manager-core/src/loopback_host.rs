/// HTTP `Host` 헤더가 허용된 로컬 loopback 주소인지 확인한다.
pub(crate) fn is_loopback_host(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
        || host.rsplit_once(':').is_some_and(|(name, port)| {
            matches!(name, "127.0.0.1" | "localhost" | "[::1]")
                && port.parse::<u16>().is_ok_and(|p| p > 0)
        })
}

#[cfg(test)]
mod tests {
    use super::is_loopback_host;

    #[test]
    fn accepts_loopback_hosts_with_and_without_ports() {
        for host in [
            "127.0.0.1",
            "127.0.0.1:4178",
            "localhost",
            "localhost:4178",
            "[::1]",
            "[::1]:4178",
        ] {
            assert!(is_loopback_host(host), "{host}");
        }
    }

    #[test]
    fn rejects_non_loopback_hosts() {
        for host in [
            "example.com",
            "192.168.0.1",
            "[::2]",
            "127.0.0.1:attacker.com",
            "127.0.0.1:",
            "127.0.0.1:0",
            "127.0.0.1:70000",
            "localhost:not_a_port",
            "[::1]:invalid",
        ] {
            assert!(!is_loopback_host(host), "{host}");
        }
    }
}
