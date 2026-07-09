import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { FsListing, Operation, Plan, PlanInput } from "@/lib/types";

export function usePlans() {
  return useQuery({
    queryKey: ["plans"],
    queryFn: () => api.get<Plan[]>("/api/plans"),
  });
}

export function useCreatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PlanInput) => api.post<Plan>("/api/plans", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["plans"] }),
  });
}

export function useUpdatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: PlanInput }) =>
      api.put<Plan>(`/api/plans/${id}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["plans"] }),
  });
}

export function useDeletePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<{ ok: boolean }>(`/api/plans/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["plans"] }),
  });
}

export function useSetPlanEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      api.post<{ ok: boolean }>(`/api/plans/${id}/enabled`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["plans"] }),
  });
}

export function useRunPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<Operation>(`/api/plans/${id}/run`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["operations"] }),
  });
}

export function useFsBrowse(path: string) {
  return useQuery({
    queryKey: ["fs", path],
    queryFn: () => api.get<FsListing>(`/api/fs/browse?path=${encodeURIComponent(path)}`),
    staleTime: 10_000,
  });
}
