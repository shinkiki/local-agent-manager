//! 로컬 loopback 주소 판정과, 그 판정에 기대는 MCP 엔드포인트 URL 규칙(E2·E3)을 모아 둔다.

use reqwest::Url;

use crate::CoreError;

fn is_loopback_name(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

/// HTTP `Host` 헤더가 허용된 로컬 loopback 주소인지 확인한다.
pub(crate) fn is_loopback_host(host: &str) -> bool {
    is_loopback_name(host)
        || host.rsplit_once(':').is_some_and(|(name, port)| {
            is_loopback_name(name) && port.parse::<u16>().is_ok_and(|p| p > 0)
        })
}

/// URL의 호스트 부분이 loopback인지 확인한다(E2). `Url::host_str`은 IPv6 주소를 대괄호째
/// 돌려주므로 `::1`의 두 표기를 모두 받는다.
pub(crate) fn is_loopback_url_host(host: &str) -> bool {
    host == "::1" || is_loopback_name(host)
}

/// MCP HTTP 엔드포인트 URL 규칙. 원격은 HTTPS, 로컬은 loopback HTTP도 허용하고(E2),
/// URL에 인증정보·query·fragment는 거절한다(E3). 정규화된 URL 문자열을 돌려준다.
pub(crate) fn validate_mcp_endpoint(input: &str) -> Result<String, CoreError> {
    let url = Url::parse(input.trim())
        .map_err(|_| CoreError::InvalidInput("올바른 MCP HTTP URL이 아닙니다".to_owned()))?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(CoreError::InvalidInput(
            "MCP URL에는 사용자정보, 비밀번호, query 또는 fragment를 넣을 수 없습니다".to_owned(),
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| CoreError::InvalidInput("MCP URL에 호스트가 없습니다".to_owned()))?;
    let loopback = is_loopback_url_host(host);
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => {
            return Err(CoreError::InvalidInput(
                "원격 MCP는 HTTPS만, 로컬 MCP는 loopback HTTP 또는 HTTPS만 허용됩니다".to_owned(),
            ))
        }
    }
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::{is_loopback_host, validate_mcp_endpoint};

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
            "::1",
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

    #[test]
    fn endpoint_requires_https_except_for_loopback() {
        assert_eq!(
            validate_mcp_endpoint(" https://mcp.notion.com/mcp ").expect("hosted url"),
            "https://mcp.notion.com/mcp"
        );
        assert!(validate_mcp_endpoint("https://example.com/mcp").is_ok());
        assert!(validate_mcp_endpoint("http://127.0.0.1:4179/mcp").is_ok());
        assert!(validate_mcp_endpoint("http://localhost:4179/mcp").is_ok());
        assert!(validate_mcp_endpoint("http://[::1]:4179/mcp").is_ok());
        assert!(validate_mcp_endpoint("http://example.com/mcp").is_err());
    }

    #[test]
    fn endpoint_rejects_credentials_in_the_url() {
        assert!(validate_mcp_endpoint("https://user:secret@example.com/mcp").is_err());
        assert!(validate_mcp_endpoint("https://example.com/mcp?token=secret").is_err());
        assert!(validate_mcp_endpoint("https://example.com/mcp#fragment").is_err());
    }
}
