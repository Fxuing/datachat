import { cn } from "../lib/utils";

export interface BrandMarkProps {
  size?: number;
  className?: string;
}

/** The DataChat app mark. Renders the shared /logo.svg so the shell, login and empty state stay in sync. */
export function BrandMark({ size = 32, className }: BrandMarkProps) {
  return (
    <img
      src="/logo.svg"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn("shrink-0 select-none", className)}
    />
  );
}
