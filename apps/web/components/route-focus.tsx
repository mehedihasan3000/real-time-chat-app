"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Moves focus to the page heading after client-side navigation.
 *
 * The first render is skipped so a normal page load keeps the browser's
 * existing focus behaviour.
 */
export function RouteFocus() {
  const pathname = usePathname();
  const previousPathname = useRef(pathname);

  useEffect(() => {
    if (previousPathname.current === pathname) {
      return;
    }

    previousPathname.current = pathname;

    const frame = window.requestAnimationFrame(() => {
      const main = document.getElementById("main-content");
      const target = main?.querySelector<HTMLElement>("h1") ?? main;

      if (!target) {
        return;
      }

      target.tabIndex = -1;
      target.dataset.routeFocus = "true";
      target.focus({ preventScroll: true });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [pathname]);

  return null;
}
