import { createContext, useContext } from "react";
import { fmt, STRINGS, type Lang } from "../i18n/strings";

export type Role = "buyer" | "realtor";

export const LangContext = createContext<Lang>("he");

export function useT() {
  const lang = useContext(LangContext);
  return { t: STRINGS[lang], f: fmt(lang), lang };
}
