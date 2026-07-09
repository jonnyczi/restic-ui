import { useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import RepoForm from "@/components/repos/RepoForm";
import RepoCard from "@/components/repos/RepoCard";
import { useRepos } from "@/hooks/useRepos";

export default function RepositoriesPage() {
  const [adding, setAdding] = useState(false);
  const { data: repos, isLoading } = useRepos();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Repositories</h1>
          <p className="text-sm text-muted-foreground">
            Where your backups are stored. One repository can hold snapshots from many plans.
          </p>
        </div>
        {!adding && (
          <Button onClick={() => setAdding(true)}>
            <Plus />
            Add repository
          </Button>
        )}
      </div>

      {adding && <RepoForm onDone={() => setAdding(false)} />}

      {isLoading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      )}

      {repos && repos.length === 0 && !adding && (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="font-medium">No repositories yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Add one to start backing up — a local folder is the quickest way to try things out.
          </p>
        </div>
      )}

      <div className="space-y-4">
        {repos?.map((r) => (
          <RepoCard key={r.id} repo={r} />
        ))}
      </div>
    </div>
  );
}
