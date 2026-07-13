import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Download,
  File,
  Folder,
  FolderInput,
  FolderOutput,
  FolderSearch,
  Loader2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import DirBrowser from "@/components/plans/DirBrowser";
import { api, ApiError } from "@/lib/api";
import { formatBytes, formatWhen, type LsNode } from "@/lib/types";

/** Browse a snapshot's contents; download files/folders or restore them. */
export default function SnapshotBrowser({
  repoId,
  snapshotId,
  onClose,
}: {
  repoId: number;
  snapshotId: string;
  onClose: () => void;
}) {
  const [path, setPath] = useState("/");
  const [restoring, setRestoring] = useState<LsNode | null>(null);
  const [target, setTarget] = useState("/restore");
  const [pickingTarget, setPickingTarget] = useState(false);
  const [notice, setNotice] = useState("");

  const WHOLE_SNAPSHOT: LsNode = { name: snapshotId.slice(0, 8), type: "dir", path: "", size: 0, mtime: "" };

  const ls = useQuery({
    queryKey: ["snap-ls", repoId, snapshotId, path],
    queryFn: () =>
      api.get<LsNode[]>(
        `/api/repos/${repoId}/snapshots/${snapshotId}/ls?path=${encodeURIComponent(path)}`,
      ),
    retry: 0,
  });

  const restore = useMutation({
    mutationFn: (body: { snapshotId: string; includePath: string; target: string }) =>
      api.post(`/api/repos/${repoId}/restore`, body),
  });

  const crumbs = ["/", ...path.split("/").filter(Boolean)];
  const crumbPath = (i: number) => "/" + crumbs.slice(1, i + 1).join("/");

  const dumpUrl = (node: LsNode) =>
    `/api/repos/${repoId}/snapshots/${snapshotId}/dump?path=${encodeURIComponent(node.path)}${
      node.type === "dir" ? "&dir=1" : ""
    }`;

  async function doRestore(node: LsNode) {
    setNotice("");
    try {
      await restore.mutateAsync({ snapshotId, includePath: node.path, target });
      setNotice(`Restore of ${node.name} started — follow it on the Operations page.`);
      setRestoring(null);
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : "Restore failed");
    }
  }

  return (
    <div className="rounded-md border bg-background p-3" data-testid="snapshot-browser">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="mr-1 rounded bg-secondary px-1.5 py-0.5 font-mono">
            {snapshotId.slice(0, 8)}
          </span>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <span className="text-muted-foreground">/</span>}
              <button
                type="button"
                className="rounded px-1 py-0.5 font-mono hover:bg-accent"
                onClick={() => setPath(i === 0 ? "/" : crumbPath(i))}
              >
                {c === "/" ? "root" : c}
              </button>
            </span>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRestoring(restoring?.path === "" ? null : WHOLE_SNAPSHOT)}
          >
            <FolderOutput />
            Restore entire snapshot
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close browser">
            <X />
          </Button>
        </div>
      </div>

      {ls.isLoading && (
        <p className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Reading snapshot…
        </p>
      )}
      {ls.isError && (
        <p className="p-2 text-sm text-destructive">
          {ls.error instanceof ApiError ? ls.error.message : "Failed to list snapshot"}
        </p>
      )}

      {ls.data && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {ls.data.length === 0 && (
                <tr>
                  <td className="p-2 text-muted-foreground">Empty directory.</td>
                </tr>
              )}
              {ls.data.map((node) => (
                <tr key={node.path} className="border-t border-border/40">
                  <td className="w-full py-1">
                    {node.type === "dir" ? (
                      <button
                        type="button"
                        onClick={() => setPath(node.path)}
                        className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-accent"
                      >
                        <Folder className="size-4 text-primary" />
                        {node.name}
                      </button>
                    ) : (
                      <span className="flex items-center gap-2 px-1 py-0.5">
                        <File className="size-4 text-muted-foreground" />
                        {node.name}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 text-xs text-muted-foreground">
                    {node.type === "file" ? formatBytes(node.size) : ""}
                  </td>
                  <td className="hidden whitespace-nowrap px-2 py-1 text-xs text-muted-foreground md:table-cell">
                    {node.mtime ? formatWhen(node.mtime) : ""}
                  </td>
                  <td className="whitespace-nowrap py-1">
                    <div className="flex gap-1">
                      <a href={dumpUrl(node)} download>
                        <Button size="sm" variant="ghost" aria-label={`Download ${node.name}`}>
                          <Download />
                        </Button>
                      </a>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Restore ${node.name}`}
                        onClick={() => setRestoring(restoring?.path === node.path ? null : node)}
                      >
                        <FolderInput />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {restoring && (
        <div className="mt-2 space-y-2 rounded-md border p-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="whitespace-nowrap text-xs text-muted-foreground">
              Restore <code>{restoring.path === "" ? "entire snapshot" : restoring.name}</code> to
            </span>
            <Input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="h-8 w-auto min-w-40 flex-1 font-mono text-xs"
            />
            <Button size="sm" variant="outline" onClick={() => setPickingTarget((v) => !v)}>
              <FolderSearch />
              Browse…
            </Button>
            <Button size="sm" onClick={() => doRestore(restoring)} disabled={restore.isPending}>
              {restore.isPending && <Loader2 className="animate-spin" />}
              Restore
            </Button>
          </div>
          {pickingTarget && (
            <DirBrowser
              onSelect={(p) => {
                setTarget(p);
                setPickingTarget(false);
              }}
              onClose={() => setPickingTarget(false)}
            />
          )}
        </div>
      )}

      {notice && (
        <p role="status" className="mt-2 text-sm text-green-500">
          {notice}
        </p>
      )}
    </div>
  );
}
