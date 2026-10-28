interface BrowserPreferences {
  tab: string;
  captureKeyboard: boolean;
  previewEnabled: boolean;
}

const storageKey = "sontrama.preferences.v1";
const defaults: BrowserPreferences = {
  tab: "instrument",
  captureKeyboard: false,
  previewEnabled: false,
};

function load(): BrowserPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    return {
      tab:
        typeof saved?.tab === "string"
          ? saved.tab
          : (localStorage.getItem("sontrama-tab") ?? defaults.tab),
      captureKeyboard:
        typeof saved?.captureKeyboard === "boolean"
          ? saved.captureKeyboard
          : false,
      previewEnabled:
        typeof saved?.previewEnabled === "boolean"
          ? saved.previewEnabled
          : false,
    };
  } catch {
    return { ...defaults };
  }
}

export const preferences = load();

export function savePreferences(update: Partial<BrowserPreferences>) {
  Object.assign(preferences, update);
  try {
    localStorage.setItem(storageKey, JSON.stringify(preferences));
  } catch {
    // Keep the controls usable when browser storage is unavailable.
  }
}
