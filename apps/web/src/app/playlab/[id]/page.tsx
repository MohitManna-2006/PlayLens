import type { Metadata } from "next";
import { Suspense } from "react";
import { PlayLabWorkspace } from "@/components/playlab/PlayLabWorkspace";

export async function generateMetadata({ params }: PageProps<"/playlab/[id]">): Promise<Metadata> {
  const { id } = await params;
  return { title: `PlayLab · ${decodeURIComponent(id)}` };
}

export default async function PlayLabPage({ params }: PageProps<"/playlab/[id]">) {
  const { id } = await params;
  return (
    <Suspense>
      <PlayLabWorkspace key={id} playId={decodeURIComponent(id)} />
    </Suspense>
  );
}
