import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { Providers } from "@/components/shell/Providers";
import { TopNav } from "@/components/shell/TopNav";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "PlayLens", template: "%s · PlayLens" },
  description: "Study football player-tracking plays: replay, compare, forecast, and inspect model evidence.",
};

export const viewport: Viewport = {
  themeColor: "#101214",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <a
          href="#workspace"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-control focus:bg-elevated focus:px-3 focus:py-2 focus:text-body-2"
        >
          Skip to workspace
        </a>
        <Providers>
          <TopNav />
          <main id="workspace" tabIndex={-1} className="outline-none">
            {children}
          </main>
        </Providers>
      </body>
    </html>
  );
}
