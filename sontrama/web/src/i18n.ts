import i18next from "i18next";
import en from "./locales/en";
import es from "./locales/es";

export type Language = "es" | "en";
export type TranslationKey = keyof typeof en;
export interface ApiIssue {
  code: string;
  message: string;
  params?: Record<string, unknown>;
}

// Bundle resources so a disconnected studio never needs a translation CDN.
await i18next.init({
  lng: "en",
  fallbackLng: "en",
  supportedLngs: ["es", "en"],
  keySeparator: false,
  resources: { es: { translation: es }, en: { translation: en } },
  interpolation: { escapeValue: false },
});

export function t(
  key: TranslationKey,
  params: Record<string, unknown> = {},
): string {
  return i18next.t(key, params);
}

export function setLanguage(language: Language) {
  if (i18next.language === language) return false;
  // Both catalogs are in memory; changing the active language is synchronous.
  void i18next.changeLanguage(language);
  document.documentElement.lang = language;
  return true;
}

export class LocalizedError extends Error {
  constructor(
    public key: TranslationKey,
    public params: Record<string, unknown> = {},
  ) {
    super(key);
  }
}

export function issueText(issue: ApiIssue): string {
  const key = `errors.${issue.code}`;
  return t(
    key in en ? (key as TranslationKey) : "errors.operation_failed",
    issue.params,
  );
}

export function apiError(detail: unknown): LocalizedError {
  if (typeof detail === "object" && detail !== null && "code" in detail) {
    const issue = detail as ApiIssue;
    const key = `errors.${issue.code}`;
    return new LocalizedError(
      key in en ? (key as TranslationKey) : "errors.operation_failed",
      issue.params,
    );
  }
  return new LocalizedError("errors.operation_failed");
}

export function errorText(error: unknown): string {
  if (error instanceof LocalizedError) return t(error.key, error.params);
  console.error(error);
  return t("errors.operation_failed");
}

// Compile-time coverage: every source message must exist in both catalogs.
const catalogs: {
  es: Record<TranslationKey, string>;
  en: Record<keyof typeof es, string>;
} = { es, en };
void catalogs;
