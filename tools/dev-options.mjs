// Runtime viewport overrides for layout e2e; product features still come from the build.
export function resolutionFlags(args) {
  if (args.length === 0) return [];
  if (args.length !== 2 || args[0] !== "--resolution") {
    throw new Error("usage: node tools/dev.mjs [--resolution WxH] -- <host flags…>");
  }
  const value = args[1];
  if (!/^[1-9]\d*x[1-9]\d*$/.test(value)
      || value.split("x").some(n => !Number.isSafeInteger(Number(n)) || Number(n) > 16384)) {
    throw new Error("--resolution expects WxH (1–16384 per dimension)");
  }
  return ["--viewport", value, "--fixed"];
}
