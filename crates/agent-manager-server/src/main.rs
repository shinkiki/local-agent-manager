fn main() -> Result<(), Box<dyn std::error::Error>> {
    agent_manager_core::run_remote_server_from_args(std::env::args().skip(1))
}
