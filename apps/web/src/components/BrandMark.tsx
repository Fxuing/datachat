import { useState } from "react";
import { DEFAULT_BRANDING, useBranding } from "../lib/branding";
import { cn } from "../lib/utils";

export interface BrandMarkProps {
  size?: number;
  className?: string;
}

/** The app mark. Uses configured runtime branding iconUrl with automatic fallback to /logo.svg. */
export function BrandMark({ size = 32, className }: BrandMarkProps) {
  const { iconUrl } = useBranding();
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const src = failedUrl === iconUrl ? DEFAULT_BRANDING.iconUrl : iconUrl;

  return (
    <img
      src={src}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      onError={() => {
        if (iconUrl !== DEFAULT_BRANDING.iconUrl) {
          setFailedUrl(iconUrl);
        }
      }}
      className={cn("shrink-0 select-none object-contain", className)}
    />
  );
}
