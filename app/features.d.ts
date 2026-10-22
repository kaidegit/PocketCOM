// Names derive from the single product registry; no runtime config import.
declare module "@pocketcom/features" {
  export function hasAppFeature(name: keyof typeof import("../pocket.features.json").features): boolean;
}
