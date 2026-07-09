import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, setCsrfToken, type AuthState } from "@/lib/api";

/** Fetches the caller's auth state and keeps the CSRF token registered. */
export function useAuth() {
  return useQuery({
    queryKey: ["auth"],
    queryFn: async () => {
      const state = await api.get<AuthState>("/api/auth/me");
      if (state.csrfToken) setCsrfToken(state.csrfToken);
      return state;
    },
    staleTime: 5 * 60 * 1000,
  });
}

interface Credentials {
  username: string;
  password: string;
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (creds: Credentials) => api.post<AuthState>("/api/auth/login", creds),
    onSuccess: (state) => {
      if (state.csrfToken) setCsrfToken(state.csrfToken);
      qc.setQueryData(["auth"], { ...state, setupRequired: false });
    },
  });
}

export function useSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (creds: Credentials) => api.post<AuthState>("/api/auth/setup", creds),
    onSuccess: (state) => {
      if (state.csrfToken) setCsrfToken(state.csrfToken);
      qc.setQueryData(["auth"], { ...state, setupRequired: false });
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean }>("/api/auth/logout"),
    onSuccess: () => {
      setCsrfToken("");
      qc.invalidateQueries({ queryKey: ["auth"] });
    },
  });
}
