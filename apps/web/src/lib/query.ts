import { QueryClient } from "@tanstack/react-query";
import { setUnauthorizedHandler } from "./api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
    mutations: {
      retry: false,
    },
  },
});

export const queryKeys = {
  me: ["me"] as const,
  conversations: ["conversations"] as const,
  conversation: (id: string) => ["conversation", id] as const,
  datasources: ["datasources"] as const,
  models: ["models"] as const,
  skills: ["skills"] as const,
  skill: (id: string) => ["skill", id] as const,
};

/**
 * Single place where a 401 becomes an app-level reaction: drop every cached query
 * (they belong to the expired session) and send the user to the login page.
 */
export function installUnauthorizedHandler(navigate: (path: string) => void): () => void {
  setUnauthorizedHandler(() => {
    queryClient.clear();
    if (typeof window !== "undefined" && window.location.pathname === "/login") return;
    navigate("/login");
  });
  return () => setUnauthorizedHandler(undefined);
}
