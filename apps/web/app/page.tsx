"use client";

import Link from "next/link";

import { ArrowRightIcon, HeartIcon } from "@/components/icons";
import { LocaleToggle } from "@/components/i18n/locale-toggle";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { ActionLink } from "@/components/ui/action-link";
import { HeartDivider } from "@/components/ui/motif";
import { PhotoFrame, PhotoStrip } from "@/components/ui/photo-frame";
import { DocumentTitle } from "@/src/i18n/document-title";
import { useI18n } from "@/src/i18n/provider";
import type { MessageKey } from "@/src/i18n/catalog";

import styles from "./page.module.css";

type Surface = {
  titleKey: MessageKey;
  descriptionKey: MessageKey;
  href: string;
  linkKey: MessageKey;
  extra?: ReadonlyArray<{ href: string; labelKey: MessageKey }>;
};

type Group = {
  id: string;
  eyebrowKey: MessageKey;
  titleKey: MessageKey;
  descriptionKey: MessageKey;
  surfaces: ReadonlyArray<Surface>;
};

const groups: ReadonlyArray<Group> = [
  {
    id: "start",
    eyebrowKey: "home.group.start.eyebrow",
    titleKey: "home.group.start.title",
    descriptionKey: "home.group.start.description",
    surfaces: [
      {
        titleKey: "home.group.start.signIn.title",
        descriptionKey: "home.group.start.signIn.description",
        href: "/sign-in",
        linkKey: "home.group.start.signIn.link",
        extra: [
          { href: "/sign-up", labelKey: "home.group.start.signIn.extra.signUp" },
          { href: "/verify-email", labelKey: "home.group.start.signIn.extra.verifyEmail" },
          { href: "/forgot-password", labelKey: "home.group.start.signIn.extra.forgotPassword" },
          { href: "/reset-password", labelKey: "home.group.start.signIn.extra.resetPassword" },
        ],
      },
      {
        titleKey: "home.group.start.profileSetup.title",
        descriptionKey: "home.group.start.profileSetup.description",
        href: "/onboarding/profile",
        linkKey: "home.group.start.profileSetup.link",
        extra: [{ href: "/profile", labelKey: "home.group.start.profileSetup.extra.profile" }],
      },
    ],
  },
  {
    id: "everyday",
    eyebrowKey: "home.group.everyday.eyebrow",
    titleKey: "home.group.everyday.title",
    descriptionKey: "home.group.everyday.description",
    surfaces: [
      {
        titleKey: "home.group.everyday.chats.title",
        descriptionKey: "home.group.everyday.chats.description",
        href: "/conversations",
        linkKey: "home.group.everyday.chats.link",
        extra: [
          {
            href: "/conversations/sample-conversation",
            labelKey: "home.group.everyday.chats.extra.thread",
          },
        ],
      },
      {
        titleKey: "home.group.everyday.calls.title",
        descriptionKey: "home.group.everyday.calls.description",
        href: "/calls",
        linkKey: "home.group.everyday.calls.link",
        extra: [{ href: "/calls/sample-call", labelKey: "home.group.everyday.calls.extra.call" }],
      },
      {
        titleKey: "home.group.everyday.search.title",
        descriptionKey: "home.group.everyday.search.description",
        href: "/search",
        linkKey: "home.group.everyday.search.link",
      },
      {
        titleKey: "home.group.everyday.profile.title",
        descriptionKey: "home.group.everyday.profile.description",
        href: "/profile",
        linkKey: "home.group.everyday.profile.link",
        extra: [
          {
            href: "/profile/nusrat_j",
            labelKey: "home.group.everyday.profile.extra.publicProfile",
          },
        ],
      },
    ],
  },
  {
    id: "trust",
    eyebrowKey: "home.group.trust.eyebrow",
    titleKey: "home.group.trust.title",
    descriptionKey: "home.group.trust.description",
    surfaces: [
      {
        titleKey: "home.group.trust.settings.title",
        descriptionKey: "home.group.trust.settings.description",
        href: "/settings",
        linkKey: "home.group.trust.settings.link",
      },
      {
        titleKey: "home.group.trust.ai.title",
        descriptionKey: "home.group.trust.ai.description",
        href: "/ai",
        linkKey: "home.group.trust.ai.link",
      },
      {
        titleKey: "home.group.trust.states.title",
        descriptionKey: "home.group.trust.states.description",
        href: "/states",
        linkKey: "home.group.trust.states.link",
      },
    ],
  },
];

export default function Home() {
  const { t } = useI18n();

  return (
    <div className={styles.shell}>
      <DocumentTitle titleKey="documentTitle.home" />
      <header className={styles.header}>
        <Link href="/" className={styles.home} aria-label={t("shell.homeAria")}>
          <span className={styles.homeMark} aria-hidden="true">
            <HeartIcon size={17} />
          </span>
          <span>{t("shell.homeTitle")}</span>
        </Link>
        <nav className={styles.headerNav} aria-label={t("nav.account")}>
          <Link href="/sign-in">{t("common.signIn")}</Link>
          <Link href="/sign-up" className={styles.headerPrimary}>
            {t("common.createAccount")}
          </Link>
          <LocaleToggle />
          <ThemeToggle />
        </nav>
      </header>

      <main id="main-content" className={styles.main} tabIndex={-1}>
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>{t("home.heroEyebrow")}</p>
            <h1 className={styles.title} id="hero-title">
              {t("home.heroTitle")}
            </h1>
            <p className={styles.lead}>{t("home.heroLead")}</p>
            <div className={styles.heroActions}>
              <ActionLink href="/conversations">{t("common.openChats")}</ActionLink>
              <ActionLink href="/sign-in" variant="secondary">
                {t("common.previewSignIn")}
              </ActionLink>
            </div>
            <ul className={styles.heroFacts} aria-label={t("home.heroFactsAria")}>
              <li>{t("common.staticRoutes")}</li>
              <li>{t("common.noLiveServices")}</li>
              <li>{t("common.lightAndDarkThemes")}</li>
            </ul>
          </div>

          <div className={styles.heroVisual}>
            <PhotoFrame
              src="/images/couple-silhouette.jpg"
              alt={t("home.photoAlt")}
              className={styles.heroPhoto}
              sizes="(min-width: 64rem) 38vw, 100vw"
              priority
              position="center 42%"
            >
              <span className={styles.photoScrim} aria-hidden="true" />
              <div className={styles.photoCaption}>
                <span className={styles.photoLabel}>{t("common.suppliedPhotography")}</span>
                <p>{t("common.localAssetNoLicence")}</p>
              </div>
            </PhotoFrame>

            <aside className={styles.buildCard} aria-labelledby="build-status-title">
              <p className={styles.buildLabel}>{t("home.buildLabel")}</p>
              <p className={styles.buildStatus} id="build-status-title">
                <span className={styles.statusDot} aria-hidden="true" />
                {t("home.buildStatus")}
              </p>
              <ul className={styles.buildList}>
                <li>{t("home.buildList1")}</li>
                <li>{t("home.buildList2")}</li>
                <li>{t("home.buildList3")}</li>
              </ul>
              <p className={styles.buildNote}>{t("home.buildNote")}</p>
            </aside>
          </div>
        </section>

        <PhotoStrip className={styles.strip} />

        <section className={styles.inventory} aria-labelledby="surfaces-title">
          <div className={styles.sectionHeader}>
            <div>
              <p className={styles.eyebrow}>{t("home.inventoryEyebrow")}</p>
              <h2 className={styles.sectionTitle} id="surfaces-title">
                {t("home.inventoryTitle")}
              </h2>
            </div>
            <p className={styles.sectionDescription}>{t("home.inventoryDescription")}</p>
          </div>

          {groups.map((group) => (
            <section className={styles.group} key={group.id} aria-labelledby={`${group.id}-title`}>
              <div className={styles.groupHeader}>
                <p className={styles.groupEyebrow}>{t(group.eyebrowKey)}</p>
                <h3 className={styles.groupTitle} id={`${group.id}-title`}>
                  {t(group.titleKey)}
                </h3>
                <p className={styles.groupDescription}>{t(group.descriptionKey)}</p>
              </div>
              <div className={styles.grid}>
                {group.surfaces.map((surface) => (
                  <article className={styles.surfaceCard} key={surface.href}>
                    <h4 className={styles.surfaceTitle}>{t(surface.titleKey)}</h4>
                    <p className={styles.surfaceDescription}>{t(surface.descriptionKey)}</p>
                    <div className={styles.surfaceFooter}>
                      <Link className={styles.surfaceLink} href={surface.href}>
                        {t(surface.linkKey)}
                        <ArrowRightIcon size={17} />
                      </Link>
                      {surface.extra ? (
                        <div className={styles.extraLinks}>
                          {surface.extra.map((link) => (
                            <Link href={link.href} key={link.href}>
                              {t(link.labelKey)}
                            </Link>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </section>

        <HeartDivider className={styles.divider} />

        <section className={styles.columns} aria-label={t("common.implementationScope")}>
          <div className={styles.scopePanel}>
            <h2 className={styles.scopeTitle}>{t("home.includesTitle")}</h2>
            <ul className={styles.list}>
              <li>{t("common.includes1")}</li>
              <li>{t("common.includes2")}</li>
              <li>{t("common.includes3")}</li>
              <li>{t("common.includes4")}</li>
              <li>{t("common.includes5")}</li>
            </ul>
          </div>
          <div className={styles.scopePanel}>
            <h2 className={styles.scopeTitle}>{t("home.excludesTitle")}</h2>
            <ul className={styles.list}>
              <li>{t("common.excludes1")}</li>
              <li>{t("common.excludes2")}</li>
              <li>{t("common.excludes3")}</li>
              <li>{t("common.excludes4")}</li>
              <li>{t("common.excludes5")}</li>
            </ul>
          </div>
        </section>

        <aside className={styles.notice} aria-label={t("home.noticeTitle")}>
          <p className={styles.noticeTitle}>{t("home.noticeTitle")}</p>
          <p>{t("home.noticeBody")}</p>
        </aside>
      </main>

      <footer className={styles.footer}>
        <p>{t("home.footerTitle")}</p>
        <nav className={styles.footerNav} aria-label={t("home.footerNavAria")}>
          <Link href="/states">{t("nav.uiStates")}</Link>
          <Link href="/settings">{t("nav.settings")}</Link>
          <Link href="/sign-in">{t("common.signIn")}</Link>
        </nav>
      </footer>
    </div>
  );
}
