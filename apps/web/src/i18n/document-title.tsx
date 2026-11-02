"use client";

import { useEffect } from "react";

import type { MessageKey } from "./catalog";
import { useI18n } from "./provider";

/**
 * Keeps the document title and meta description in the active locale. Static
 * route metadata stays as an English pre-hydration fallback; this updates both
 * as soon as the provider knows the stored language.
 *
 * Next.js re-applies the server metadata title when hydration commits, after
 * this effect has run. A small observer keeps the localized title authoritative
 * without fighting unrelated head changes.
 */
export function DocumentTitle({ titleKey }: { titleKey: MessageKey }) {
  const { t } = useI18n();

  useEffect(() => {
    const title = t(titleKey);
    const descriptionText = t("documentTitle.description");

    function apply() {
      if (document.title !== title) {
        document.title = title;
      }

      let description = document.querySelector('meta[name="description"]');

      if (!description) {
        description = document.createElement("meta");
        description.setAttribute("name", "description");
        document.head.appendChild(description);
      }

      if (description.getAttribute("content") !== descriptionText) {
        description.setAttribute("content", descriptionText);
      }
    }

    apply();

    const observer = new MutationObserver(apply);
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => observer.disconnect();
  }, [t, titleKey]);

  return null;
}
