import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Operation, Repo, RepoInput, RepoStats, RepoStatsPoint, Snapshot } from "@/lib/types";

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

/** Forget a single snapshot (async op; snapshot list refreshes via the event stream). */
export function useForgetSnapshot() {
  return useMutation({
    mutationFn: ({ repoId, snapshotId }: { repoId: number; snapshotId: string }) =>
      api.post<Operation>(`/api/repos/${repoId}/snapshots/${snapshotId}/forget`),
  });
}

/** Prune unreferenced data from a repository (async op). */
export function usePruneRepo() {
  return useMutation({
    mutationFn: (repoId: number) => api.post<Operation>(`/api/repos/${repoId}/prune`),
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

export function useRepoStatsHistory(repoId: number | null) {
  return useQuery({
    queryKey: ["repo-stats-history", repoId],
    queryFn: () => api.get<RepoStatsPoint[]>(`/api/repos/${repoId}/stats/history`),
    enabled: repoId !== null,
    retry: 0,
  });
}
