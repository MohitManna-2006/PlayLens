"use client";

import { Info, Keyboard, Menu as MenuIcon, PanelRight } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { MenuButton } from "@/components/ui/Menu";
import { Popover } from "@/components/ui/Popover";
import { Tooltip } from "@/components/ui/Tooltip";
import { useAnalystState } from "@/lib/analyst/store";
import { DATA_SOURCE_KIND } from "@/lib/datasource";
import { useAnalystStore } from "./Providers";
import { ShortcutsDialog } from "./ShortcutsDialog";

const DESTINATIONS = [
  { href: "/explore", label: "Explore" },
  { href: "/evaluation", label: "Evaluation" },
];

export function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const analyst = useAnalystStore();
  const { open } = useAnalystState(analyst);
  const [shortcuts, setShortcuts] = useState(false);
  const triggerRef = useCallback((el: HTMLButtonElement | null) => analyst.setTrigger(el), [analyst]);
  // Inside play workspaces the breadcrumb provides location; no destination is marked active (§5).
  const active = DESTINATIONS.find((d) => pathname === d.href || pathname.startsWith(`${d.href}/`))?.href;

  return (
    <header className="sticky top-0 z-30 h-14 border-b border-border bg-bg">
      <div className="mx-auto flex h-full max-w-[calc(1680px+2*var(--page-pad))] items-stretch px-[var(--page-pad)]">
        <Link href="/explore" className="wordmark mr-4 flex items-center self-center rounded-control text-fg md:mr-6">
          PlayLens
        </Link>
        <nav aria-label="Primary" className="hidden items-stretch md:flex">
          {DESTINATIONS.map((d) => (
            <Link
              key={d.href}
              href={d.href}
              aria-current={active === d.href ? "page" : undefined}
              className={`relative flex items-center px-3 text-body-2 font-medium transition-colors duration-[var(--dur-hover)] hover:bg-hover focus-visible:outline-offset-[-2px] ${
                active === d.href ? "text-fg" : "text-fg-2 hover:text-fg"
              }`}
            >
              {d.label}
              {active === d.href && <span aria-hidden className="absolute inset-x-3 bottom-0 h-0.5 bg-accent" />}
            </Link>
          ))}
        </nav>
        <div className="flex items-center md:hidden">
          <MenuButton
            label="Navigation"
            triggerClassName="btn btn-quiet"
            triggerContent={
              <>
                <MenuIcon size={16} strokeWidth={1.5} aria-hidden />
                <span>Menu</span>
              </>
            }
            showChevron={false}
            groups={[
              {
                items: DESTINATIONS.map((d) => ({ value: d.href, label: d.label, kind: "action" as const, checked: active === d.href })),
              },
            ]}
            onSelect={(item) => router.push(item.value)}
          />
        </div>

        <div className="ml-auto flex items-center gap-1">
          {DATA_SOURCE_KIND === "fixture" && <FixtureNotice />}
          <button
            type="button"
            ref={triggerRef}
            className={`btn btn-quiet ${open ? "text-fg" : ""}`}
            aria-expanded={open}
            aria-controls="analyst-pane"
            onClick={() => analyst.toggle()}
          >
            <PanelRight size={16} strokeWidth={1.5} aria-hidden />
            Analyst
          </button>
          <Tooltip content="Keyboard shortcuts" describe={false}>
            <button
              type="button"
              className="btn btn-quiet btn-icon hidden md:inline-flex"
              aria-label="Keyboard shortcuts"
              onClick={() => setShortcuts(true)}
            >
              <Keyboard size={16} strokeWidth={1.5} aria-hidden />
            </button>
          </Tooltip>
        </div>
      </div>
      <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} />
    </header>
  );
}

function FixtureNotice() {
  return (
    <Popover
      label="About the synthetic fixture"
      placement="bottom-end"
      width={320}
      className="p-4"
      trigger={(props) => (
        <button type="button" {...props} className="btn btn-quiet text-muted">
          <Info size={14} strokeWidth={1.5} aria-hidden />
          <span className="hidden lg:inline">Synthetic fixture data</span>
          <span className="lg:hidden">Fixture</span>
        </button>
      )}
    >
      {() => (
        <div className="space-y-2 text-body-2 text-fg-2">
          <p className="font-medium text-fg">Synthetic fixture data</p>
          <p>
            Plays are procedurally generated for interface development. They are not NFL tracking data, and players carry no
            names.
          </p>
          <p>
            Forecasts come from a constant-velocity baseline, retrieval from a handcrafted formation descriptor, and PlayLab from
            a development mock. None has an evaluation run.
          </p>
          <p className="text-caption text-muted">Set NEXT_PUBLIC_PLAYLENS_DATA_SOURCE=api to use the PlayLens API.</p>
        </div>
      )}
    </Popover>
  );
}
