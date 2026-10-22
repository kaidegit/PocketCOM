// Callable feature names derive from validated profiles, excluding planned entries.
declare module "@pocketcom/features" {
  type Profiles = typeof import("../pocket.features.json").profiles;
  export function hasAppFeature(name: keyof Profiles[keyof Profiles]): boolean;
}
