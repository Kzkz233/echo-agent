use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=avatar.manifest");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let manifest = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
            .join("avatar.manifest");
        println!("cargo:rustc-link-arg-bin=echo-avatar=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-bin=echo-avatar=/MANIFESTINPUT:{}", manifest.display());
    }
}
