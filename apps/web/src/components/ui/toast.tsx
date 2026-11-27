import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { cn } from "../../lib/utils";

export type ToastTone = "success" | "error" | "info";

export interface ToastItem {
  id: string;
  tone: ToastTone;
  message: string;
}

export interface ToastActions {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

export interface ToastContextValue {
  toast: ToastActions;
  dismiss: (id: string) => void;
}

const DEFAULT_DURATION_MS = 3_500;

const NOOP_CONTEXT: ToastContextValue = {
  toast: {
    success: () => undefined,
    error: () => undefined,
    info: () => undefined,
  },
  dismiss: () => undefined,
};

const ToastContext = createContext<ToastContextValue>(NOOP_CONTEXT);

const TONE_ICONS: Record<ToastTone, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

const TONE_STYLES: Record<ToastTone, string> = {
  success: "border-success/30 text-ink",
  error: "border-danger/30 text-danger",
  info: "border-line text-ink",
};

const TONE_ICON_COLORS: Record<ToastTone, string> = {
  success: "text-success",
  error: "text-danger",
  info: "text-brand",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, number>>(new Map());
  const seqRef = useRef(0);

  const dismiss = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string) => {
      const trimmed = message.trim();
      if (!trimmed) return;
      seqRef.current += 1;
      const id = `toast-${seqRef.current}`;
      setItems((prev) => [...prev.slice(-4), { id, tone, message: trimmed }]);
      const timer = window.setTimeout(() => {
        timersRef.current.delete(id);
        setItems((prev) => prev.filter((item) => item.id !== id));
      }, DEFAULT_DURATION_MS);
      timersRef.current.set(id, timer);
    },
    [],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      toast: {
        success: (message) => push("success", message),
        error: (message) => push("error", message),
        info: (message) => push("info", message),
      },
      dismiss,
    }),
    [dismiss, push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex max-w-sm flex-col gap-2 print:hidden"
      >
        {items.map((item) => {
          const Icon = TONE_ICONS[item.tone];
          return (
            <div
              key={item.id}
              role="status"
              className={cn(
                "animate-fade-in pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-surface px-3.5 py-2.5 text-xs shadow-pop",
                TONE_STYLES[item.tone],
              )}
            >
              <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", TONE_ICON_COLORS[item.tone])} />
              <span className="min-w-0 flex-1 leading-5">{item.message}</span>
              <button
                type="button"
                aria-label="关闭提示"
                onClick={() => dismiss(item.id)}
                className="rounded p-0.5 text-muted transition-colors hover:bg-subtle hover:text-ink"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

/** Safe outside ToastProvider: falls back to no-ops in isolated component tests. */
export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}
