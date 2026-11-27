import { useEffect, useState, type RefObject } from "react";
import { cn } from "../../lib/utils";
import type { ReportHeading } from "../../lib/report-toc";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

function useActiveHeading(headings: ReportHeading[], scrollRef: RefObject<HTMLDivElement | null>) {
  const [activeId, setActiveId] = useState(headings[0]?.id ?? "");

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || headings.length === 0) return;

    const update = () => {
      const threshold = container.getBoundingClientRect().top + 96;
      let current = headings[0]?.id ?? "";
      for (const heading of headings) {
        const element = document.getElementById(heading.id);
        if (!element) continue;
        if (element.getBoundingClientRect().top <= threshold) current = heading.id;
        else break;
      }
      setActiveId((previous) => (previous === current ? previous : current));
    };

    update();
    container.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      container.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [headings, scrollRef]);

  return activeId;
}

export function ReportToc({
  headings,
  activeId,
  onSelect,
}: {
  headings: ReportHeading[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  if (headings.length < 2) return null;

  return (
    <nav
      aria-label="目录"
      className="group absolute left-2 top-8 z-20 hidden w-11 overflow-hidden rounded-xl border border-transparent p-1.5 transition-[width,background-color,border-color,box-shadow] duration-200 hover:w-40 hover:border-line hover:bg-surface/95 hover:shadow-card hover:backdrop-blur xl:block print:hidden"
    >
      <div className="flex w-7 flex-col items-start gap-1.5 group-hover:hidden">
        {headings.map((heading) => (
          <button
            key={heading.id}
            type="button"
            aria-label={heading.text}
            onClick={() => onSelect(heading.id)}
            className="flex h-2 w-7 items-center"
          >
            <span
              className={cn(
                "h-0.5 rounded-full transition-colors",
                heading.id === activeId ? "bg-brand" : "bg-linestrong/60",
                heading.level === 1 ? "w-7" : heading.level === 2 ? "w-5" : "w-3.5",
              )}
            />
          </button>
        ))}
      </div>

      <div className="hidden group-hover:block">
        <p className="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted">目录</p>
        <div className="max-h-[60vh] overflow-y-auto">
          {headings.map((heading) => (
            <Tooltip key={heading.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onSelect(heading.id)}
                  className={cn(
                    "block w-full truncate rounded-md px-2 py-1 text-left text-xs transition-colors",
                    heading.level === 2 ? "pl-4" : heading.level === 3 ? "pl-6" : "",
                    heading.id === activeId
                      ? "bg-subtle font-medium text-brand"
                      : "text-inksoft hover:bg-subtle",
                  )}
                >
                  {heading.text}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{heading.text}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </div>
    </nav>
  );
}

export function useReportTocActive(
  headings: ReportHeading[],
  scrollRef: RefObject<HTMLDivElement | null>,
) {
  return useActiveHeading(headings, scrollRef);
}
