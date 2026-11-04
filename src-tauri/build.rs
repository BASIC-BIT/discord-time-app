fn main() {
    println!("cargo:rerun-if-env-changed=HOSTED_SLM_DEFAULT_API_KEY");
    tauri_build::build()
}
