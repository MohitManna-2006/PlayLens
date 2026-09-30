"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { AnnouncerProvider } from "@/components/ui/Announcer";
import { DATA_SOURCE_KIND } from "@/lib/datasource";
import { AnalystStore } from "@/lib/analyst/store";
import { HttpAnalystTransport, LocalToolTransport } from "@/lib/analyst/transports";

const AnalystContext = createContext<AnalystStore | null>(null);

export function useAnalystStore(): AnalystStore {
  const s = useContext(AnalystContext);
  if (!s) throw new Error("AnalystStore missing");
  return s;
}

export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 5 * 60_000, retry: 1, refetchOnWindowFocus: false },
        },
      }),
  );
  const [analyst] = useState(
    () =>
      new AnalystStore(
        DATA_SOURCE_KIND === "api"
          ? new HttpAnalystTransport(process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000")
          : new LocalToolTransport(),
      ),
  );
  useEffect(() => {
    analyst.setNavigate((href) => router.push(href));
  }, [analyst, router]);

  return (
    <QueryClientProvider client={queryClient}>
      <AnnouncerProvider>
        <AnalystContext.Provider value={analyst}>{children}</AnalystContext.Provider>
      </AnnouncerProvider>
    </QueryClientProvider>
  );
}
