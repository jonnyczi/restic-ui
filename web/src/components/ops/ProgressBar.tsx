import { formatBytes, type OpProgress } from "@/lib/types";

/** Live files/bytes bar for a running operation. Renders nothing without data. */
export default function ProgressBar({ progress }: { progress: OpProgress | null | undefined }) {
  if (!progress) return null;
  return (
    <div className="space-y-1" data-testid="op-progress">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span className="min-w-0 break-all">
          {progress.filesDone}/{progress.totalFiles} files ·{" "}
          {formatBytes(progress.bytesDone)}/{formatBytes(progress.totalBytes)}
          {progress.currentFile && <> · {progress.currentFile}</>}
        </span>
        <span>{Math.round(progress.percentDone * 100)}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-secondary">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${Math.round(progress.percentDone * 100)}%` }}
        />
      </div>
    </div>
  );
}
