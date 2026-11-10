fn main() {
    println!("cargo:rerun-if-changed=../../dist/build-info.json");
    let info = std::fs::read_to_string("../../dist/build-info.json")
        .expect("Build the Echo frontend and backend before building the desktop");
    println!("cargo:rustc-env=ECHO_BUILD_INFO={}", info.replace(['\r', '\n'], ""));
    tauri_build::build()
}
