fn main() {
    println!("cargo:rerun-if-env-changed=HOSTED_SLM_DEFAULT_API_KEY");
    let mut attributes = tauri_build::Attributes::new();
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        embed_common_controls_manifest();
    }
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}

/// tauri-build's default manifest (Common Controls v6) reaches the app binary only.
/// Embedding the same manifest through the linker covers the unit-test binary too,
/// which otherwise fails to load once it links tauri's mock runtime
/// (STATUS_ENTRYPOINT_NOT_FOUND).
fn embed_common_controls_manifest() {
    let manifest = std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("app.manifest");
    std::fs::write(
        &manifest,
        r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*" />
    </dependentAssembly>
  </dependency>
</assembly>
"#,
    )
    .unwrap();
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
}
