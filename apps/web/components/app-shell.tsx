"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { HeartIcon } from "@/components/icons";
import { LocaleToggle } from "@/components/i18n/locale-toggle";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { useI18n } from "@/src/i18n/provider";

import { MobileHeader } from "./shell/mobile-header";
import { PrimaryNav } from "./shell/primary-nav";

import styles from "./app-shell.module.css";

export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useI18n();

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar} aria-label={t("common.application")}>
        <Link href="/" className={styles.home} aria-label={t("shell.homeAria")}>
          <span className={styles.homeMark} aria-hidden="true">
            <HeartIcon size={18} />
          </span>
          <span className={styles.homeCopy}>
            <span className={styles.homeTitle}>{t("shell.homeTitle")}</span>
            <span className={styles.homeSub}>{t("shell.homeSub")}</span>
          </span>
        </Link>

        <PrimaryNav variant="sidebar" />

        <div className={styles.sidebarFooter}>
          <aside className={styles.connection} aria-label={t("common.connectionStatus")}>
            <span className={styles.connectionDot} aria-hidden="true" />
            <p>
              <strong>{t("shell.notConnectedTitle")}</strong>
              <span>{t("shell.notConnectedBody")}</span>
            </p>
          </aside>
          <div className={styles.utility}>
            <Link href="/" className={styles.utilityLink}>
              {t("shell.routeInventory")}
            </Link>
            <LocaleToggle />
            <ThemeToggle />
          </div>
        </div>
      </aside>

      <div className={styles.body}>
        <MobileHeader />
        <PrimaryNav variant="bottom" />
        <aside className={styles.mobileStatus} aria-label={t("common.connectionStatus")}>
          <span className={styles.connectionDot} aria-hidden="true" />
          <p>
            <strong>{t("common.notConnectedSentence")}</strong> {t("shell.mobileStatus")}
          </p>
        </aside>

        <main id="main-content" className={styles.main} tabIndex={-1}>
          {children}
        </main>

        <footer className={styles.footer}>
          <p>{t("shell.footer")}</p>
          <nav aria-label={t("nav.secondary")}>
            <Link href="/">{t("nav.uiSurfaces")}</Link>
            <Link href="/states">{t("nav.uiStates")}</Link>
            <Link href="/settings">{t("nav.settings")}</Link>
          </nav>
        </footer>
      </div>
    </div>
  );
}
