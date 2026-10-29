import type { Metadata, Viewport } from "next";

import { RouteFocus } from "@/components/route-focus";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Real-Time Chat and Calling",
    template: "%s · Real-Time Chat and Calling",
  },
  description: "A one-to-one real-time chat and audio/video calling web application.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b0d12",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <RouteFocus />
        {children}
      </body>
    </html>
  );
}
