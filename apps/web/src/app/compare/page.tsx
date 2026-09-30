import type { Metadata } from "next";
import { Suspense } from "react";
import { CompareWorkspace } from "@/components/compare/CompareWorkspace";

export const metadata: Metadata = { title: "Compare" };

export default function ComparePage() {
  return (
    <Suspense>
      <CompareWorkspace />
    </Suspense>
  );
}
