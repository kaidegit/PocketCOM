export interface LauncherOptions {
  /** --baked-text: render from the AIC-faithful baked atlas (no CoreText). */
  bakedText: boolean;
  /** --resolution WxH: host flags pinning a fixed logical viewport. */
  viewportFlags: string[];
}

export function launcherFlags(args: string[]): LauncherOptions;
