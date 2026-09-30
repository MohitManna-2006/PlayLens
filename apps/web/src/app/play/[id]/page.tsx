import type { Metadata } from "next";
import { Suspense } from "react";
import { PlayWorkspace } from "@/components/play/PlayWorkspace";

export async function generateMetadata({ params }: PageProps<"/play/[id]">): Promise<Metadata> {
  const { id } = await params;
  return { title: `Play ${decodeURIComponent(id)}` };
}

export default async function PlayPage({ params }: PageProps<"/play/[id]">) {
  const { id } = await params;
  return (
    <Suspense>
      <PlayWorkspace key={id} playId={decodeURIComponent(id)} />
    </Suspense>
  );
}
