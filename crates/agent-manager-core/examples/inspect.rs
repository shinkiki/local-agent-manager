use std::env;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let app_data_dir = env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| env::temp_dir().join("agent-manager-inspect"));
    let _ownership = agent_manager_core::BackendOwnershipLease::acquire(&app_data_dir)?;
    let snapshot = agent_manager_core::load_manager_snapshot(&app_data_dir)?;
    println!(
        "sessions={} skills={} agents={} artifacts={}",
        snapshot.sessions.len(),
        snapshot.skills.len(),
        snapshot.agents.len(),
        snapshot.artifacts.len()
    );
    for source in [
        agent_manager_core::ProviderId::Claude,
        agent_manager_core::ProviderId::Codex,
        agent_manager_core::ProviderId::Antigravity,
    ] {
        if let Some(session) = snapshot
            .sessions
            .iter()
            .find(|session| session.source == source && session.readable)
        {
            let detail = agent_manager_core::load_session_detail(
                &app_data_dir,
                session.source,
                &session.id,
            )?;
            println!(
                "{} sample_transcript={}",
                source.as_str(),
                detail.transcript.len()
            );
        }
    }
    for provider in snapshot.status.providers {
        println!(
            "{} cli={} history={}",
            provider.provider.as_str(),
            provider.cli.detected,
            provider.history.detected
        );
    }
    Ok(())
}
