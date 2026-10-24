// Launcher options for layout e2e and AIC baked-font simulation; product
// features still come from the build.
export function launcherFlags(args) {
  const out = { bakedText: false, viewportFlags: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--baked-text") {
      out.bakedText = true;
    } else if (args[i] === "--resolution") {
      const value = args[++i];
      if (value === undefined
          || !/^[1-9]\d*x[1-9]\d*$/.test(value)
          || value.split("x").some(n => !Number.isSafeInteger(Number(n)) || Number(n) > 16384)) {
        throw new Error("--resolution expects WxH (1–16384 per dimension)");
      }
      out.viewportFlags = ["--viewport", value, "--fixed"];
    } else {
      throw new Error(`usage: node tools/dev.mjs [--baked-text] [--resolution WxH] -- <host flags…> (unknown ${args[i]})`);
    }
  }
  return out;
}
