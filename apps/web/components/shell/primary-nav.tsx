"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ChatIcon, PhoneIcon, SearchIcon, UserIcon } from "@/components/icons";
import { useI18n } from "@/src/i18n/provider";

import styles from "./primary-nav.module.css";

const items = [
  { href: "/conversations", labelKey: "nav.chats", icon: ChatIcon },
  { href: "/calls", labelKey: "nav.calls", icon: PhoneIcon },
  { href: "/search", labelKey: "nav.search", icon: SearchIcon },
  { href: "/profile", labelKey: "nav.profile", icon: UserIcon },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === "/profile") {
    return (
      pathname === "/profile" ||
      pathname.startsWith("/profile/") ||
      pathname === "/settings" ||
      pathname.startsWith("/settings/")
    );
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

export function PrimaryNav({ variant }: { variant: "sidebar" | "bottom" }) {
  const pathname = usePathname();
  const { t } = useI18n();

  return (
    <nav
      className={`${styles.nav} ${variant === "sidebar" ? styles.sidebar : styles.bottom}`}
      aria-label={t("nav.primary")}
    >
      <ul className={styles.list}>
        {items.map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = item.icon;

          return (
            <li className={styles.item} key={item.href}>
              <Link
                href={item.href}
                className={styles.link}
                aria-current={active ? "page" : undefined}
              >
                <span className={styles.icon} aria-hidden="true">
                  <Icon size={variant === "bottom" ? 22 : 20} />
                </span>
                <span className={styles.label}>{t(item.labelKey)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
