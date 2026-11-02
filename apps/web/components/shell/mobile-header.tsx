"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ChevronLeftIcon } from "@/components/icons";
import { LocaleToggle } from "@/components/i18n/locale-toggle";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { useI18n } from "@/src/i18n/provider";
import type { MessageKey } from "@/src/i18n/catalog";

import styles from "./mobile-header.module.css";

type RouteContext = {
  titleKey: MessageKey;
  backHref?: string;
  backLabelKey?: MessageKey;
};

function routeContext(pathname: string): RouteContext {
  if (pathname.startsWith("/conversations/")) {
    return {
      titleKey: "nav.conversation",
      backHref: "/conversations",
      backLabelKey: "common.backToChats",
    };
  }

  if (pathname.startsWith("/calls/")) {
    return { titleKey: "nav.call", backHref: "/calls", backLabelKey: "common.backToCalls" };
  }

  if (pathname.startsWith("/profile/")) {
    return {
      titleKey: "nav.profile",
      backHref: "/profile",
      backLabelKey: "common.backToProfile",
    };
  }

  if (pathname === "/settings" || pathname.startsWith("/settings/")) {
    return {
      titleKey: "nav.settings",
      backHref: "/profile",
      backLabelKey: "common.backToProfile",
    };
  }

  if (pathname === "/ai") {
    return {
      titleKey: "nav.aiAssist",
      backHref: "/conversations",
      backLabelKey: "common.backToChats",
    };
  }

  if (pathname === "/states") {
    return {
      titleKey: "nav.uiStates",
      backHref: "/",
      backLabelKey: "common.backToUiSurfaces",
    };
  }

  if (pathname === "/calls") {
    return { titleKey: "nav.calls" };
  }

  if (pathname === "/search") {
    return { titleKey: "nav.search" };
  }

  if (pathname === "/profile") {
    return { titleKey: "nav.profile" };
  }

  return { titleKey: "nav.chats" };
}

export function MobileHeader() {
  const pathname = usePathname();
  const context = routeContext(pathname);
  const { t } = useI18n();

  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        {context.backHref ? (
          <Link
            href={context.backHref}
            className={styles.back}
            aria-label={context.backLabelKey ? t(context.backLabelKey) : undefined}
          >
            <ChevronLeftIcon size={20} />
          </Link>
        ) : null}
        <p className={styles.title}>{t(context.titleKey)}</p>
        <LocaleToggle className={styles.theme} />
        <ThemeToggle className={styles.theme} />
      </div>
    </header>
  );
}
