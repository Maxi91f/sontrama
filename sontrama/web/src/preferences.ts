// Navigation is local; application preferences are synchronized by the server.
const storageKey = "sontrama.preferences.v1";
let saved: Record<string, unknown> = {};
try {
  saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") ?? {};
} catch {
  // Browser storage may be unavailable or contain a malformed legacy value.
}
export const preferences = {
  tab: typeof saved.tab === "string" ? saved.tab : "instrument",
};
export const legacyPreferences = {
  capture:
    typeof saved.captureKeyboard === "boolean"
      ? saved.captureKeyboard
      : undefined,
  preview:
    typeof saved.previewEnabled === "boolean"
      ? saved.previewEnabled
      : undefined,
};
export function savePreferences(update: Partial<typeof preferences>) {
  Object.assign(preferences, update);
  try {
    // Keep legacy values until the server has accepted their migration.
    localStorage.setItem(
      storageKey,
      JSON.stringify({ ...saved, ...preferences }),
    );
  } catch {
    // Navigation remains usable without browser storage.
  }
}
export function discardLegacyPreferences() {
  saved = {};
  savePreferences({});
}
