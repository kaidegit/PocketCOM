//! `main.rs` tests — scheduling, realm isolation, repaint hashing, system
//! plan resolution, script flag parsing. No window opened; pure logic +
//! engine/surface primitives.
//!
//! Mirrored under test/host/macos/ per repo convention; compiled into the
//! `pocketcom-host` bin via `#[path]` from host/macos/src/main.rs, so
//! `use super::*` reaches main.rs's private items.

use super::*;

fn args_from(argv: &[&str]) -> Result<Args> {
    parse_args_from(argv.iter().map(|s| s.to_string()))
}

#[test]
fn parse_args_from_is_injectable_and_defaults_match() {
    let a = args_from(&[]).unwrap();
    assert_eq!(a.app, "note-main");
    assert!(a.screenshots.is_empty());
    assert!(a.script.is_empty());
    assert_eq!(a.quit_after_ticks, None);
}

#[test]
fn screenshot_flag_parses_path_at_tick() {
    let a = args_from(&["--screenshot", "/tmp/a.png@120"]).unwrap();
    assert_eq!(a.screenshots, vec![(120, PathBuf::from("/tmp/a.png"))]);
}

#[test]
fn screenshot_flag_is_repeatable_and_mixes_with_other_script_flags() {
    let a = args_from(&[
        "--quit-after",
        "200",
        "--screenshot",
        "shot1.png@30",
        "--click",
        "10,20@5",
        "--screenshot",
        "/tmp/shot2.png@90",
    ])
    .unwrap();
    assert_eq!(
        a.screenshots,
        vec![(30, PathBuf::from("shot1.png")), (90, PathBuf::from("/tmp/shot2.png"))]
    );
    assert_eq!(a.quit_after_ticks, Some(200));
    assert!(matches!(a.script.as_slice(), [ScriptEvent::Click(5, x, y)] if *x == 10.0 && *y == 20.0));
}

#[test]
fn screenshot_flag_rejects_malformed_specs() {
    // Missing value.
    assert!(args_from(&["--screenshot"]).is_err());
    // Missing @TICK.
    assert!(args_from(&["--screenshot", "noatt.png"]).is_err());
    // Empty path.
    assert!(args_from(&["--screenshot", "@10"]).is_err());
    // Non-numeric tick.
    assert!(args_from(&["--screenshot", "a.png@abc"]).is_err());
    // Unknown flags stay rejected.
    assert!(args_from(&["--unknown"]).is_err());
}


#[test]
fn app_supervisor_uses_lifecycle_focus_and_shell_painter_order() {
    let mut facts = [
        SchedulingFact {
            visible: true,
            focused: false,
            order: 10,
            state: AppInstanceState::Running,
        },
        SchedulingFact {
            visible: false,
            focused: false,
            order: 20,
            state: AppInstanceState::Suspended,
        },
        SchedulingFact {
            visible: true,
            focused: true,
            order: 30,
            state: AppInstanceState::Running,
        },
        SchedulingFact {
            visible: true,
            focused: true,
            order: 25,
            state: AppInstanceState::Failed,
        },
    ];
    assert_eq!(focused_app_instance(&facts), Some(2));
    assert_eq!(scheduled_app_instances(&facts), vec![2, 0]);
    facts[1].state = AppInstanceState::Running;
    assert_eq!(scheduled_app_instances(&facts), vec![2, 1, 0]);
}

#[test]
fn app_instances_do_not_share_quickjs_globals() {
    let hero = Guest::new().unwrap();
    let settings = Guest::new().unwrap();
    hero.eval("hero", "globalThis.realmProbe = 41;").unwrap();
    settings
        .eval(
            "settings",
            "globalThis.realmProbeWasAbsent = typeof realmProbe === 'undefined';",
        )
        .unwrap();

    let hero_probe: i32 = hero.with(|ctx| ctx.globals().get("realmProbe").unwrap());
    let settings_absent: bool =
        settings.with(|ctx| ctx.globals().get("realmProbeWasAbsent").unwrap());
    assert_eq!(hero_probe, 41);
    assert!(settings_absent);
}

#[test]
fn app_instance_repaint_hash_includes_raster_revision() {
    let surface = UiSurface::new((16.0, 16.0));
    let texture = surface.with_ui(|ui| {
        ui.upload_texture(
            &[0xff, 0xff, 0xff, 0xff],
            1,
            1,
            pocketjs_core::spec::psm::PSM_8888,
        )
    });
    assert!(texture >= 0);

    let (words_before, revision_before) =
        surface.with_ui(|ui| (ui.draw().words.clone(), ui.raster_revision()));
    let mut hash_before = 0xcbf2_9ce4_8422_2325u64;
    mix_app_instance_repaint_hash(&mut hash_before, 7, fnv1a64(&words_before), revision_before);

    surface.with_ui(|ui| ui.free_texture(texture));
    let (words_after, revision_after) =
        surface.with_ui(|ui| (ui.draw().words.clone(), ui.raster_revision()));
    let mut hash_after = 0xcbf2_9ce4_8422_2325u64;
    mix_app_instance_repaint_hash(&mut hash_after, 7, fnv1a64(&words_after), revision_after);

    assert_eq!(words_after, words_before);
    assert_ne!(revision_after, revision_before);
    assert_ne!(hash_after, hash_before);
}

#[test]
fn resolved_system_plan_uses_the_exact_system_ui_wire_key() {
    let plan: ResolvedSystemPlan = serde_json::from_value(serde_json::json!({
        "system": {
            "id": "dev.pocket-stack.desktop",
            "name": "pocket-desktop",
            "title": "Pocket Desktop",
            "version": "0.1.0"
        },
        "target": { "id": HOST_ID, "hostAbi": 4 },
        "roles": { "systemUI": "dev.pocket-stack.shell" },
        "lifecycle": { "backgroundExecution": "suspend" },
        "installation": {
            "installedPackages": ["dev.pocket-stack.shell"]
        },
        "systemUI": {
            "package": "dev.pocket-stack.shell",
            "source": "apps/shell/pocket.json",
            "required": true,
            "plan": {
                "app": {
                    "id": "dev.pocket-stack.shell",
                    "output": "shell-main",
                    "title": "System UI",
                    "version": "0.1.0",
                    "entry": "apps/shell/main.tsx",
                    "framework": "solid"
                },
                "target": { "id": HOST_ID, "hostAbi": 4 },
                "viewport": {
                    "logical": [800, 600],
                    "physical": [1600, 1200],
                    "presentation": "native",
                    "rasterDensity": 2,
                    "policy": "dynamic"
                },
                "features": { "ui.compositor-surfaces": true },
                "companions": ["system-ui"],
                "planHash": "sha256:package"
            }
        },
        "applications": [],
        "planHash": "sha256:system"
    }))
    .unwrap();

    assert_eq!(plan.roles.system_ui, "dev.pocket-stack.shell");
    assert_eq!(plan.system_ui.package, "dev.pocket-stack.shell");
    assert!(plan.validate_for_host().is_ok());
}
