import type { Metadata, Viewport } from "next";
import { Fraunces, Manrope, Noto_Sans_Bengali } from "next/font/google";

import { RouteFocus } from "@/components/route-focus";
import { SkipLink } from "@/components/skip-link";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { localeInitScript } from "@/src/i18n/init-script";
import { LocaleProvider } from "@/src/i18n/provider";

import "./globals.css";

const fraunces = Fraunces({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-fraunces",
});

const manrope = Manrope({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-manrope",
});

const notoSansBengali = Noto_Sans_Bengali({
  subsets: ["bengali", "latin"],
  display: "swap",
  variable: "--font-noto-bengali",
});

export const metadata: Metadata = {
  title: {
    default: "Chat and calling — UI preview",
    template: "%s · UI preview",
  },
  description:
    "A static, labelled preview of the one-to-one chat and calling interface. No live services are connected.",
  applicationName: "Chat and calling UI preview",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbf7f3" },
    { media: "(prefers-color-scheme: dark)", color: "#1b1218" },
  ],
};

const themeScript = `(function () {
  var resolved = "light";
  try {
    var stored = window.localStorage.getItem("chat-ui-theme");
    if (stored === "dark" || stored === "light") {
      resolved = stored;
    } else {
      resolved = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
  } catch (error) {
    try {
      resolved = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch (nestedError) {
      resolved = "light";
    }
  }
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${manrope.variable} ${notoSansBengali.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: localeInitScript }} />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <ThemeProvider>
          <LocaleProvider>
            <SkipLink />
            <RouteFocus />
            {children}
          </LocaleProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
