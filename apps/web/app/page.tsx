import Link from "next/link";

import { ActionLink } from "@/components/ui/action-link";

import styles from "./page.module.css";

const surfaces = [
  {
    title: "Authentication",
    description:
      "Sign-in, registration, email verification, forgot-password, and reset-password screens.",
    href: "/sign-in",
    linkLabel: "Open sign-in",
    extra: [
      { href: "/sign-up", label: "Create account" },
      { href: "/verify-email", label: "Verify email" },
      { href: "/forgot-password", label: "Forgot password" },
      { href: "/reset-password", label: "Reset password" },
    ],
  },
  {
    title: "Conversations",
    description:
      "Conversation list and thread layout with empty, loading, error, and disconnected states.",
    href: "/conversations",
    linkLabel: "Open conversations",
  },
  {
    title: "Search",
    description: "Exact-username discovery surface with neutral empty and unsupported states.",
    href: "/search",
    linkLabel: "Open search",
  },
  {
    title: "Profile",
    description: "Own profile and public profile views with a generated initials avatar.",
    href: "/profile",
    linkLabel: "Open profile",
  },
  {
    title: "Calls",
    description: "Call history, call detail, and media-control states for audio and video calls.",
    href: "/calls",
    linkLabel: "Open calls",
  },
  {
    title: "AI assistance",
    description:
      "Release-gated AI surfaces with consent, unavailable, and provider-failure states.",
    href: "/ai",
    linkLabel: "Open AI",
  },
  {
    title: "Settings",
    description:
      "Account, privacy, notifications, language, data, and session sections with placeholder controls.",
    href: "/settings",
    linkLabel: "Open settings",
  },
  {
    title: "UI states",
    description: "A static gallery of the shared loading, empty, error, and disconnected states.",
    href: "/states",
    linkLabel: "Open state gallery",
  },
] as const;

export default function Home() {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="Real-Time Chat and Calling home">
          <span className={styles.brandMark} aria-hidden="true">
            RC
          </span>
          <span>Real-Time Chat</span>
        </Link>
        <nav className={styles.accountNav} aria-label="Account">
          <Link href="/sign-in">Sign in</Link>
          <Link href="/sign-up" className={styles.accountPrimary}>
            Create account
          </Link>
        </nav>
      </header>

      <main id="main-content" className={styles.main} tabIndex={-1}>
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>UI shell preview</p>
            <h1 className={styles.title} id="hero-title">
              One-to-one chat and calling, built in the open.
            </h1>
            <p className={styles.lead}>
              This repository now has a navigable shell for every MVP surface. Authentication,
              messaging, calls, AI, and persistence are still placeholders, and each screen says so.
            </p>
            <div className={styles.actions}>
              <ActionLink href="/conversations">Preview the app</ActionLink>
              <ActionLink href="/sign-up" variant="secondary">
                Create an account
              </ActionLink>
            </div>
          </div>

          <aside className={styles.previewCard} aria-labelledby="build-status-title">
            <p className={styles.previewLabel}>Current build</p>
            <p className={styles.previewStatus} id="build-status-title">
              <span className={styles.statusDot} aria-hidden="true" />
              Static shell — not connected
            </p>
            <ul className={styles.previewList}>
              <li>Routes, navigation, and shared UI states are present.</li>
              <li>Keyboard focus, labels, and a skip link are in place.</li>
              <li>No session, message, call, or AI request is made.</li>
            </ul>
            <p className={styles.previewNote}>
              No security, capacity, or accessibility certification is claimed.
            </p>
          </aside>
        </section>

        <section aria-labelledby="surfaces-title">
          <div className={styles.sectionHeader}>
            <div>
              <p className={styles.eyebrow}>Route inventory</p>
              <h2 className={styles.sectionTitle} id="surfaces-title">
                MVP surfaces
              </h2>
            </div>
            <p className={styles.sectionDescription}>
              Every surface below is reachable from this page and from the primary navigation.
            </p>
          </div>

          <div className={styles.grid}>
            {surfaces.map((surface) => (
              <article className={styles.surfaceCard} key={surface.href}>
                <h3 className={styles.surfaceTitle}>{surface.title}</h3>
                <p className={styles.surfaceDescription}>{surface.description}</p>
                <div className={styles.surfaceLinks}>
                  <Link href={surface.href}>{surface.linkLabel}</Link>
                  {"extra" in surface
                    ? surface.extra.map((link) => (
                        <Link href={link.href} key={link.href}>
                          {link.label}
                        </Link>
                      ))
                    : null}
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.columns} aria-label="Implementation scope">
          <div className={styles.scopePanel}>
            <h2 className={styles.sectionTitle}>What this shell includes</h2>
            <ul className={styles.list}>
              <li>Responsive layout with a skip link, visible focus, and semantic landmarks.</li>
              <li>Primary navigation with a current-page indicator.</li>
              <li>
                Shared loading, empty, error, disconnected, unauthorized, and unsupported states.
              </li>
              <li>Generated initials avatars with no upload or external image request.</li>
              <li>English placeholder copy; Bengali localization is tracked separately.</li>
            </ul>
          </div>
          <div className={styles.scopePanel}>
            <h2 className={styles.sectionTitle}>What is not implemented</h2>
            <ul className={styles.list}>
              <li>Registration, sign-in, sessions, email verification, and password reset.</li>
              <li>Message sending, history, receipts, presence, typing, and unread state.</li>
              <li>Audio/video calls, media permissions, TURN, and call signaling.</li>
              <li>AI consent, prompts, summaries, replies, and translation.</li>
              <li>Profiles, discovery, blocking, reporting, and persistence.</li>
            </ul>
          </div>
        </section>

        <aside className={styles.notice} aria-label="Preview limitation">
          <p className={styles.noticeTitle}>Preview limitation</p>
          <p>
            This is non-irreversible scaffolding for later tasks. It does not fake authentication,
            messaging, calls, AI, or success behavior. The status banner in the app shell always
            reads “Not connected” until real transport exists.
          </p>
        </aside>
      </main>

      <footer className={styles.footer}>
        <p>Real-Time Chat and Calling · UI shell preview</p>
        <nav className={styles.footerNav} aria-label="Secondary">
          <Link href="/states">UI states</Link>
          <Link href="/settings">Settings</Link>
          <Link href="/sign-in">Sign in</Link>
        </nav>
      </footer>
    </div>
  );
}
