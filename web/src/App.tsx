import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useEventStream } from "@/hooks/useOperations";
import AuthPage from "@/pages/AuthPage";
import DashboardPage from "@/pages/DashboardPage";
import SettingsPage from "@/pages/SettingsPage";
import RepositoriesPage from "@/pages/RepositoriesPage";
import PlansPage from "@/pages/PlansPage";
import OperationsPage from "@/pages/OperationsPage";
import NotFoundPage from "@/pages/NotFoundPage";
import AppShell from "@/components/AppShell";

export default function App() {
  const { data: auth, isLoading, isError } = useAuth();
  useEventStream(Boolean(auth?.authenticated));

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError || !auth) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <p className="text-destructive">Cannot reach the backend. Is the server running?</p>
      </div>
    );
  }

  if (auth.setupRequired) return <AuthPage mode="setup" />;
  if (!auth.authenticated) return <AuthPage mode="login" />;

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell username={auth.username} />}>
          <Route index element={<DashboardPage />} />
          <Route path="repos" element={<RepositoriesPage />} />
          <Route path="plans" element={<PlansPage />} />
          <Route path="operations" element={<OperationsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
