import Link from "next/link";
import { Fragment, type ReactNode } from "react";

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * 72 px workspace heading (§7): breadcrumb with contextual actions, identity
 * line, and compact mono metadata. The breadcrumb is location, not a second
 * navigation bar.
 */
export function WorkspaceHeader({
  crumbs,
  title,
  subtitle,
  meta,
  actions,
  loading = false,
}: {
  crumbs: Crumb[];
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode[];
  actions?: ReactNode;
  loading?: boolean;
}) {
  return (
    <header className="flex h-[72px] flex-col justify-center overflow-hidden">
      <div className="flex h-7 shrink-0 items-center justify-between gap-4">
        <nav aria-label="Breadcrumb" className="min-w-0">
          <ol className="flex items-center gap-1.5 text-caption text-muted">
            {crumbs.map((c, i) => (
              <Fragment key={i}>
                {i > 0 && <li aria-hidden>/</li>}
                <li className="truncate">
                  {c.href ? (
                    <Link href={c.href} className="link-quiet">
                      {c.label}
                    </Link>
                  ) : (
                    <span aria-current="page" className="num text-fg-2">
                      {c.label}
                    </span>
                  )}
                </li>
              </Fragment>
            ))}
          </ol>
        </nav>
        {actions && <div className="flex shrink-0 items-center gap-1 [&_.btn]:h-7">{actions}</div>}
      </div>
      {loading ? (
        <div aria-hidden>
          <div className="skeleton mt-1 h-5 w-72" />
          <div className="skeleton mt-2 h-3 w-96 max-w-full" />
        </div>
      ) : (
        <>
          <h1 className="flex h-6 min-w-0 shrink-0 items-baseline gap-2 text-section font-semibold">
            <span className="shrink-0">{title}</span>
            {subtitle && <span className="truncate text-body font-normal text-fg-2">· {subtitle}</span>}
          </h1>
          {meta && meta.length > 0 && (
            <p className="num flex h-[18px] min-w-0 items-center gap-x-4 overflow-hidden text-meta whitespace-nowrap text-fg-2">
              {meta.map((m, i) => (
                <span key={i}>{m}</span>
              ))}
            </p>
          )}
        </>
      )}
    </header>
  );
}
