import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Repo, RepoInput, RepoStats, Snapshot } from "@/lib/types";

export function useRepos() {
  return useQuery({
    queryKey: ["repos"],
    queryFn: () => api.get<Repo[]>("/api/repos"),
  });
}

export function useCreateRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RepoInput) => api.post<Repo>("/api/repos", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["repos"] }),
  });
}

export function useDeleteRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<{ ok: boolean }>(`/api/repos/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["repos"] }),
  });
}

/** Fire a named action (init/test/check/unlock) against a repo. */
export function useRepoAction() {
  return useMutation({
    mutationFn: ({ id, action }: { id: number; action: "init" | "test" | "check" | "unlock" }) =>
      api.post<Record<string, unknown>>(`/api/repos/${id}/${action}`),
  });
}

export function useSnapshots(repoId: number | null) {
  return useQuery({
    queryKey: ["snapshots", repoId],
    queryFn: () => api.get<Snapshot[]>(`/api/repos/${repoId}/snapshots`),
    enabled: repoId !== null,
    retry: 0,
  });
}

export function useRepoStats(repoId: number | null) {
  return useQuery({
    queryKey: ["repo-stats", repoId],
    queryFn: () => api.get<RepoStats>(`/api/repos/${repoId}/stats`),
    enabled: repoId !== null,
    retry: 0,
  });
}
