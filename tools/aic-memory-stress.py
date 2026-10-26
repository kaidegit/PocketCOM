#!/usr/bin/env python3
"""Actual package / QuickJS / native-core touch stress, with per-action checks.

Prerequisite: npm run package:aic. All generated sources, logs and receipts stay
in .pocket/aic/memory-stress/. --busy models the GC scheduler seeing no idle
frames; it does not claim to generate serial traffic or render RGB565 damage.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--heap", default="7m")
    parser.add_argument("--gc", choices=["policy", "idle", "none", "compare"], default="policy")
    parser.add_argument("--busy", action="store_true")
    parser.add_argument("--rapid", action="store_true")
    parser.add_argument("--combined-cycles", type=int, default=0, help="repeat the full drawer/settings/keyboard workflow (0..50)")
    parser.add_argument("--scenario", action="append", choices=["collapse", "keyboard-collapse", "keyboard", "combined"])
    parser.add_argument("--package", type=Path, default=ROOT / "dist/aic/pocketcom-aic.pocket")
    parser.add_argument("--tag", default="latest")
    args = parser.parse_args()
    if not 0 <= args.combined_cycles <= 50:
        parser.error("--combined-cycles must be within 0..50 (bounded probe event lists)")
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", args.tag):
        parser.error("--tag must be a filename component")
    package = args.package.resolve()
    out = ROOT / ".pocket/aic/memory-stress" / args.tag
    out.mkdir(parents=True, exist_ok=True)
    with (out / "build.log").open("w") as log:
        subprocess.run(["bun", "host/rtthread/probe.ts", str(package), "--turns", "1"],
                       cwd=ROOT, stdout=log, stderr=log, check=True)

    # Instrument only this test executable. Product packages stay byte-identical.
    # The hooks and state queries have the same cost in both GC modes.
    hooks = r'''
globalThis.com={serialList:()=>'[{"path":"uart1","description":"UART1"}]',write:()=>true,close:()=>true,poll:()=>null};
const texts={},parents={};let keyboardHost=0;
const setText=ui.setText.bind(ui),replaceText=ui.replaceText.bind(ui),destroyNode=ui.destroyNode.bind(ui),insertBefore=ui.insertBefore.bind(ui),setProp=ui.setProp.bind(ui);
ui.setText=(id,s)=>{texts[id]=s;return setText(id,s)};
ui.replaceText=(id,s)=>{texts[id]=s;return replaceText(id,s)};
ui.destroyNode=id=>{const clear=n=>{for(const c of Object.keys(parents))if(parents[c]===Number(n))clear(c);delete texts[n];delete parents[n]};clear(id);return destroyNode(id)};
ui.insertBefore=(parent,id,anchor)=>{parents[id]=parent;return insertBefore(parent,id,anchor)};
ui.setProp=(id,p,v)=>{if(p===31&&v===1001)keyboardHost=id;return setProp(id,p,v)};
globalThis.__stressState=()=>{let open=false;for(let id=ui.hitTestBounds(29,126);id;id=parents[id])if(id===keyboardHost)open=true;return {hit:ui.hitTestBounds(100,200),send:Object.keys(texts).find(id=>texts[id]==='发送'),open,host:keyboardHost,q:Object.values(texts).filter(s=>s==='q').length,zq:Object.values(texts).filter(s=>s==='zq').length,historyEdited:Object.values(texts).filter(s=>s==='100002').length}};
'''
    source = (ROOT / "host/rtthread/probe/probe.c").read_text()
    marker = "  JSValue patch = JS_Eval(context, logfix"
    assert source.count(marker) == 1, "probe setup changed; update stress hook"
    setup = '  const char *hooks = ' + json.dumps(hooks) + ''';
  JSValue hooked = JS_Eval(context, hooks, strlen(hooks), "stress-hooks", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(hooked)) abort();
  JS_FreeValue(context, hooked);
'''
    source = source.replace(marker, setup + marker)
    marker = "        sample(label);"
    assert source.count(marker) == 2, "probe sampling changed; update stress hook"
    source = source.replace(marker, marker + r'''
        const char *read = "JSON.stringify(__stressState())";
        JSValue state = JS_Eval(context, read, strlen(read), "stress-state", JS_EVAL_TYPE_GLOBAL);
        if (JS_IsException(state)) { sample("state-failed"); probe_heap_print_fails(); return 1; }
        const char *value = JS_ToCString(context, state);
        if (!value) { sample("state-failed"); probe_heap_print_fails(); return 1; }
        printf("[STATE] turn=%ld json=%s\n", turn, value);
        JS_FreeCString(context, value); JS_FreeValue(context, state);
''')
    if args.busy:
        marker = "const bool idle = frame.raster_revision == raster_revision;"
        assert source.count(marker) == 1, "probe idle detection changed"
        source = source.replace(marker, "const bool idle = false; /* synthetic continuous damage */")
    cfile = out / "stress.c"
    cfile.write_text(source)
    host = ROOT / "vendor/pocketjs/hosts/aic"
    components = ROOT / "vendor/pocketjs/hosts/esp-idf/components"
    probe = ROOT / "host/rtthread/probe"
    includes = [probe, host / "port", host / "port/esp_compat", host / "third_party/quickjs-ng",
                probe / "rtstub", host / "generated"]
    includes += [components / name / "include" for name in
                 ["pocketjs_package", "pocketjs_guest", "pocketjs_ui_core", "pocketjs_ui_qjs", "pocketjs_render_rgb565"]]
    obj = out / "stress.o"
    subprocess.run(["cc", "-O2", "-c", str(cfile), "-o", str(obj),
                    *["-I" + str(p) for p in includes]], check=True)
    cache = ROOT / ".pocket/aic/probe-host"
    objects = [cache / (name + ".o") for name in ["quickjs", "dtoa", "libregexp", "libunicode",
               "quickjs-libc", "stub", "heap", "tlsf", "package", "guest", "ui_core", "ui_qjs", "render_rgb565"]]
    binary = out / "stress"
    subprocess.run(["cc", "-O2", "-o", str(binary), str(obj), *map(str, objects),
                    str(probe / "native/target/release/libpocketcom_aic_probe_native.a"), "-lm"], check=True)

    report = {"package": str(package), "packageSha256": hashlib.sha256(package.read_bytes()).hexdigest(),
              "policySha256": hashlib.sha256((host / "port/pocketjs_gc.h").read_bytes()).hexdigest(),
              "heap": args.heap, "busy": args.busy, "rapid": args.rapid, "combinedCycles": args.combined_cycles, "runs": []}
    for mode in (["idle", "policy"] if args.gc == "compare" else [args.gc]):
        for scenario in args.scenario or ["collapse", "keyboard-collapse", "keyboard"]:
            turns, interval = (3600, 4) if args.rapid else (48000, 115)
            command = [str(binary), str(package), "--heap", args.heap, "--turns", str(turns)]
            if mode != "none": command += ["--aic-gc" if mode == "policy" else "--aic-gc-idle"]
            expected = {}
            expected_hits = {}
            expected_edits = {}

            def tap(xy, turn):
                command.extend(["--tap", f"{xy}@{turn}"])

            def sample(turn):
                command.extend(["--sample", str(turn)])

            if scenario != "collapse":
                for xy, turn in [("100,200", 5), ("100,200", 12), ("29,126", 20), ("430,226", 30)]: tap(xy, turn)
            if scenario == "combined":
                command[command.index("--turns") + 1] = str(turns if args.combined_cycles else 240)
                for turn, state in [(24, True), (34, False), (144, False)]:
                    sample(turn); expected[turn] = state
                expected_hits.update({144: "drawer", 152: "settings", 192: "send"})
                # Move the preview caret, insert z, then edit the settings field.
                tap("10,34", 26); tap("29,190", 28)
                for turn in range(40, 121, 16):
                    tap("100,200", turn); sample(turn+4); expected[turn+4] = True
                    tap("430,226", turn+8); sample(turn+12); expected[turn+12] = False
                for xy, turn in [("60,16", 140), ("130,249", 148), ("250,99", 156), ("250,99", 164),
                                 ("76,98", 172), ("430,226", 180), ("450,10", 188)]: tap(xy, turn)
                for turn, state in [(152, False), (160, False), (168, True), (184, False), (192, False)]:
                    sample(turn); expected[turn] = state
                for cycle in range(args.combined_cycles):
                    base = 240 + cycle * (64 if args.rapid else 900)
                    # Retain the send draft, reopen the cached drawer/settings,
                    # focus then open the keyboard, type 2 and erase it, cancel.
                    for xy, offset, opened in [("60,16", 0, False), ("130,249", 4, False),
                            ("250,99", 8, False), ("250,99", 12, True), ("76,98", 16, True),
                            ("240,226", 20, True), ("430,226", 24, False), ("450,10", 28, False)]:
                        # Odd cycles cancel an edited draft; the next open must
                        # reset it. Even cycles also exercise Backspace.
                        if offset != 20 or cycle % 2 == 0: tap(xy, base+offset)
                        sample(base+offset+3); expected[base+offset+3] = opened
                    expected_hits.update({base+3: "drawer", base+7: "settings", base+27: "settings", base+31: "send"})
                    expected_edits.update({base+15: False, base+19: True, base+23: cycle % 2 != 0})
            else:
                for i in range(400):
                    turn = 40 + i*interval
                    tap("444,258" if scenario != "keyboard" else ("100,200" if i%2 == 0 else "430,226"), turn)
                    sample(turn+3); expected[turn+3] = i%2 == 0
            name = mode + "-" + scenario
            (out / (name + "-command.json")).write_text(json.dumps(command, indent=2))
            result = subprocess.run(command, capture_output=True, text=True)
            (out / (name + ".log")).write_text(result.stdout + result.stderr)
            states = {}
            for match in re.finditer(r"\[STATE\] turn=(\d+) json=(.*)", result.stdout):
                try: states[int(match[1])] = json.loads(match[2])
                except json.JSONDecodeError:
                    assert result.returncode, "invalid state in successful run"
            error = None
            if result.returncode == 0:
                try:
                    assert states.keys() == expected.keys(), "missing state checks"
                    if scenario in ["keyboard", "combined"]:
                        assert all(states[t]["open"] == state for t, state in expected.items()), "keyboard state mismatch"
                        if scenario == "combined":
                            hits = {"send": states[34]["hit"], "drawer": states[144]["hit"], "settings": states[152]["hit"]}
                            assert len(set(hits.values())) == 3 and all(hits.values()), "workflow did not expose three different views"
                            assert all(states[t]["hit"] == hits[name] for t, name in expected_hits.items()), "drawer/settings did not reopen or close"
                            assert states[24]["q"] >= 2 and all(states[t]["zq"] >= 1 for t in expected if t >= 34), "send draft was lost or not rendered"
                            assert all((states[t]["historyEdited"] >= 2) == edited for t, edited in expected_edits.items()), "settings keyboard input/backspace failed"
                    else:
                        hits = list(states.values())
                        assert hits[0]["hit"] != hits[1]["hit"], "collapse did not change hit target"
                        assert all(states[t]["hit"] == hits[0 if collapsed else 1]["hit"] for t, collapsed in expected.items()), "collapse state mismatch"
                        assert len({s.get("send") for s in hits}) == 1 and hits[0].get("send"), "send node was recreated"
                except AssertionError as e: error = str(e)
            run = {"mode": mode, "scenario": scenario, "exit": result.returncode,
                   "checks": len(states), "expected": len(expected), "error": error}
            for field in ["sys_max", "caps_peak", "caps_fails", "gc_count"]:
                values = re.findall(r"\b" + field + r"=(\d+)", result.stdout)
                if values: run[field] = int(values[-1])
            report["runs"].append(run)
            print(json.dumps(run), flush=True)
    (out / "report.json").write_text(json.dumps(report, indent=2))
    # A failing old-policy comparison is evidence; a failing candidate is a gate.
    checked = [r for r in report["runs"] if args.gc != "compare" or r["mode"] == "policy"]
    return int(any(r["exit"] or r["error"] or r.get("caps_fails", 0) for r in checked))


if __name__ == "__main__":
    raise SystemExit(main())
