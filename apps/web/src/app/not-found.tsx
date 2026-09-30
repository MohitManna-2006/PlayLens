import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-[680px] px-[var(--page-pad)] py-12">
      <h1 className="text-page font-semibold">Page not found</h1>
      <p className="mt-2 text-body text-fg-2">This address does not match a PlayLens workspace.</p>
      <Link href="/explore" className="btn btn-primary mt-6">
        Go to Explore
      </Link>
    </div>
  );
}
