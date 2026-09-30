import type { Metadata } from "next";
import { Suspense } from "react";
import { ExploreScreen } from "@/components/explore/ExploreScreen";

export const metadata: Metadata = { title: "Explore" };

export default function ExplorePage() {
  return (
    <Suspense>
      <ExploreScreen />
    </Suspense>
  );
}
