fn main() {
    println!("cargo:rerun-if-env-changed=HOSTED_SLM_DEFAULT_API_KEY");
    println!("cargo:rerun-if-changed=../.env.local");
    for name in ["VITE_CLERK_ISSUER", "VITE_CLERK_OAUTH_CLIENT_ID"] {
        println!("cargo:rerun-if-env-changed={name}");
        if std::env::var(name).is_ok() {
            continue;
        }
        if let Ok(env) = std::fs::read_to_string("../.env.local") {
            if let Some(value) = env
                .lines()
                .find_map(|line| line.strip_prefix(&format!("{name}=")))
            {
                let value = value.trim().trim_matches('"').trim_matches('\'');
                println!("cargo:rustc-env={name}={value}");
            }
        }
    }
    tauri_build::build()
}
