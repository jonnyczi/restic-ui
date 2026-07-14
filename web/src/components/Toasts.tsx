import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, X, XCircle } from "lucide-react";
import { dismissToast, useToasts, type Toast } from "@/lib/toastStore";

const KIND_ICONS = {
  success: <CheckCircle2 className="size-4 shrink-0 text-green-500" />,
  warning: <AlertTriangle className="size-4 shrink-0 text-amber-500" />,
  error: <XCircle className="size-4 shrink-0 text-destructive" />,
} as const;

function ToastCard({ toast }: { toast: Toast }) {
  return (
    <div
      role="status"
      data-testid="toast"
      className="flex items-start gap-2 rounded-lg border bg-background p-3 shadow-lg"
    >
      {KIND_ICONS[toast.kind]}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{toast.title}</p>
        {toast.message && (
          <p className="mt-0.5 break-all text-xs text-muted-foreground">{toast.message}</p>
        )}
        <Link
          to="/operations"
          onClick={() => dismissToast(toast.id)}
          className="mt-1 inline-block text-xs text-muted-foreground underline hover:text-foreground"
        >
          View operations
        </Link>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => dismissToast(toast.id)}
        className="text-muted-foreground hover:text-foreground"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

/** Fixed corner stack of live operation toasts. */
export default function Toasts() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}
