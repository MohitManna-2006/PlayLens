import type { Metadata } from "next";
import { Suspense } from "react";
import { EvaluationReport } from "@/components/evaluation/EvaluationReport";

export const metadata: Metadata = { title: "Evaluation" };

export default function EvaluationPage() {
  return (
    <Suspense>
      <EvaluationReport />
    </Suspense>
  );
}
