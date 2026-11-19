fn main() {
    println!("cargo:rerun-if-env-changed=HOSTED_SLM_DEFAULT_API_KEY");
    println!("cargo:rerun-if-env-changed=VITE_CLERK_PUBLISHABLE_KEY");
    println!("cargo:rerun-if-changed=../.env.local");
    // Share Vite's local public key with the native Clerk transport. CI supplies it through the environment.
    if std::env::var("VITE_CLERK_PUBLISHABLE_KEY").is_err() {
        if let Ok(env) = std::fs::read_to_string("../.env.local") {
            if let Some(key) = env.lines().find_map(|line| line.strip_prefix("VITE_CLERK_PUBLISHABLE_KEY=")) {
                let key = key.trim().trim_matches('"').trim_matches('\'');
                if key.starts_with("pk_") {
                    println!("cargo:rustc-env=VITE_CLERK_PUBLISHABLE_KEY={key}");
                }
            }
        }
    }
    tauri_build::build()
}
