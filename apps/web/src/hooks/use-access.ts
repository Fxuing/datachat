import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Permission } from "@datachat/shared";
import { fetchMe } from "../lib/api";
import { queryKeys } from "../lib/query";

export interface Access {
  permissions: ReadonlySet<Permission>;
  roles: { id: string; name: string }[];
  isAdmin: boolean;
  loading: boolean;
}

/** Shared view of `/api/auth/me`; every consumer reuses the same query cache entry. */
export function useAccess(): Access {
  const meQuery = useQuery({
    queryKey: queryKeys.me,
    queryFn: fetchMe,
    staleTime: 60_000,
  });

  const permissions = useMemo(
    () => new Set(meQuery.data?.permissions ?? []),
    [meQuery.data?.permissions],
  );

  return {
    permissions,
    roles: meQuery.data?.roles ?? [],
    isAdmin: meQuery.data?.user.role === "admin",
    loading: meQuery.isPending,
  };
}

export function useCan(permission: Permission): boolean {
  return useAccess().permissions.has(permission);
}

export function useIsAdmin(): boolean {
  return useAccess().isAdmin;
}
