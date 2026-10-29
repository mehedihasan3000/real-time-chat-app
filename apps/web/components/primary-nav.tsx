"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import styles from "./primary-nav.module.css";

const links = [
  { href: "/conversations", label: "Conversations" },
  { href: "/search", label: "Search" },
  { href: "/calls", label: "Calls" },
  { href: "/ai", label: "AI" },
  { href: "/settings", label: "Settings" },
  { href: "/profile", label: "Profile" },
] as const;

export function PrimaryNav() {
  const pathname = usePathname();

  return (
    <nav className={styles.nav} aria-label="Primary">
      <ul className={styles.list}>
        {links.map((link) => {
          const active = pathname === link.href || pathname.startsWith(`${link.href}/`);

          return (
            <li key={link.href}>
              <Link
                href={link.href}
                className={styles.link}
                aria-current={active ? "page" : undefined}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
