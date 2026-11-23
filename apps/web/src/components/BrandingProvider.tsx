import { useEffect, useState, type ReactNode } from "react";
import {
  applyDocumentBranding,
  BrandingContext,
  DEFAULT_BRANDING,
  normalizeBranding,
  readCachedBranding,
  writeCachedBranding,
  type AppBranding,
} from "../lib/branding";

export function BrandingProvider({
  children,
  initialBranding,
}: {
  children: ReactNode;
  /** Test seam to provide branding synchronously without fetching. */
  initialBranding?: AppBranding;
}) {
  const [branding, setBranding] = useState<AppBranding>(
    () => initialBranding ?? readCachedBranding() ?? DEFAULT_BRANDING,
  );

  useEffect(() => {
    applyDocumentBranding(branding);
  }, [branding]);

  useEffect(() => {
    if (initialBranding) return;
    let cancelled = false;

    fetch("/api/public/branding", {
      credentials: "omit",
      cache: "no-store",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (cancelled || !payload) return;
        const next = normalizeBranding(payload);
        setBranding(next);
        writeCachedBranding(next);
      })
      .catch(() => {
        // Keep defaults / cached branding if the endpoint is unreachable.
      });

    return () => {
      cancelled = true;
    };
  }, [initialBranding]);

  return <BrandingContext.Provider value={branding}>{children}</BrandingContext.Provider>;
}
