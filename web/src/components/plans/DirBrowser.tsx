import { useState } from "react";
import { ArrowUp, Check, Folder, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFsBrowse } from "@/hooks/usePlans";

/** Inline folder picker backed by /api/fs/browse. */
export default function DirBrowser({
  onSelect,
  onClose,
}: {
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState("/");
  const { data, isLoading, isError, error } = useFsBrowse(path);

  return (
    <div className="rounded-md border bg-background p-3" data-testid="dir-browser">
      <div className="mb-2 flex items-center justify-between gap-2">
        <code className="truncate text-xs text-muted-foreground">{path}</code>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!data?.parent}
            onClick={() => data?.parent && setPath(data.parent)}
          >
            <ArrowUp /> Up
          </Button>
          <Button type="button" size="sm" onClick={() => onSelect(path)}>
            <Check /> Select this folder
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      {isLoading && (
        <p className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      )}
      {isError && (
        <p className="p-2 text-sm text-destructive">
          {error instanceof Error ? error.message : "Cannot read directory"}
        </p>
      )}
      {data && (
        <ul className="max-h-48 space-y-0.5 overflow-y-auto">
          {data.entries.length === 0 && (
            <li className="p-2 text-sm text-muted-foreground">No subfolders.</li>
          )}
          {data.entries.map((e) => (
            <li key={e.path}>
              <button
                type="button"
                onClick={() => setPath(e.path)}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent"
              >
                <Folder className="size-4 text-muted-foreground" />
                {e.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
