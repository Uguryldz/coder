"use client";

import { ToastProvider } from "@/components/ui/toast";
import { dataProvider } from "@/lib/data-provider";
import { Refine } from "@refinedev/core";
import routerProvider from "@refinedev/nextjs-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionProvider } from "next-auth/react";
import * as React from "react";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
});

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <Refine
            dataProvider={dataProvider}
            routerProvider={routerProvider}
            options={{ disableTelemetry: true, syncWithLocation: false }}
            resources={[
              { name: "agent-variants" },
              { name: "prompt-versions" },
              { name: "knowledge-files" },
              { name: "variant-knowledge-links" },
              { name: "routing-rules" },
              { name: "golden-tickets" },
              { name: "evaluations" },
              { name: "workflow-runs" },
              { name: "step-executions" },
              { name: "human-decisions" },
              { name: "audit-logs" },
              { name: "users" },
              { name: "settings" },
              { name: "pii-configs" },
            ]}
          >
            {children}
          </Refine>
        </ToastProvider>
      </QueryClientProvider>
    </SessionProvider>
  );
}
