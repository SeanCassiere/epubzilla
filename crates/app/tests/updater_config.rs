use std::{fs, path::PathBuf};

use serde_json::Value;

const MANIFEST_ENDPOINT: &str =
    "https://github.com/SeanCassiere/epubzilla/releases/latest/download/latest.json";
const RELEASE_URL: &str = "https://github.com/SeanCassiere/epubzilla/releases/latest";

fn manifest_file(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(name);
    serde_json::from_str(&fs::read_to_string(path).expect("configuration should be readable"))
        .expect("configuration should be valid JSON")
}

#[test]
fn updater_configuration_uses_the_production_endpoint_and_artifacts() {
    let config = manifest_file("tauri.conf.json");
    assert_eq!(config["bundle"]["createUpdaterArtifacts"], true);
    assert_eq!(
        config["plugins"]["updater"]["endpoints"][0],
        MANIFEST_ENDPOINT
    );
    assert!(config["plugins"]["updater"]["pubkey"]
        .as_str()
        .is_some_and(|key| !key.is_empty() && !key.contains("REPLACE_WITH_")));
}

#[test]
fn capabilities_expose_discovery_and_the_exact_handoff_only() {
    let capabilities = manifest_file("capabilities/default.json");
    let permissions = capabilities["permissions"]
        .as_array()
        .expect("permissions should be an array");

    let updater_permissions: Vec<_> = permissions
        .iter()
        .filter_map(Value::as_str)
        .filter(|permission| permission.starts_with("updater:"))
        .collect();
    assert_eq!(updater_permissions, ["updater:allow-check"]);
    let opener = permissions
        .iter()
        .find(|entry| entry["identifier"] == "opener:allow-open-url")
        .expect("the URL opener permission should exist");
    assert_eq!(opener["allow"].as_array().expect("allow scope").len(), 1);
    assert_eq!(opener["allow"][0]["url"], RELEASE_URL);

    let serialized = serde_json::to_string(permissions).unwrap();
    for forbidden in [
        "updater:default",
        "updater:allow-download",
        "updater:allow-install",
        "updater:allow-download-and-install",
        "opener:default",
        "process:",
        "relaunch",
        "restart",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "forbidden capability exposed: {forbidden}"
        );
    }
}
