import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { HardDriveDownload, LogOut, Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLogout } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Dashboard" },
  { to: "/repos", label: "Repositories" },
  { to: "/plans", label: "Plans" },
  { to: "/operations", label: "Operations" },
  { to: "/settings", label: "Settings" },
];

/** Top-level chrome: header with nav + identity, routed content below. */
export default function AppShell({ username }: { username?: string }) {
  const logout = useLogout();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <HardDriveDownload className="size-5 text-primary" />
              <span className="font-semibold tracking-tight">restic-ui</span>
            </div>
            <nav className="hidden items-center gap-1 md:flex">
              {NAV.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/"}
                  className={({ isActive }) =>
                    cn(
                      "rounded-md px-3 py-1.5 text-sm transition-colors",
                      isActive
                        ? "bg-secondary font-medium"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            {username && (
              <span
                className="hidden text-sm text-muted-foreground md:inline"
                data-testid="current-user"
              >
                {username}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
            >
              <LogOut />
              Log out
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label="Toggle navigation"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              {menuOpen ? <X /> : <Menu />}
            </Button>
          </div>
        </div>
        {menuOpen && (
          <nav className="border-t px-4 py-2 md:hidden" data-testid="mobile-nav">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                onClick={() => setMenuOpen(false)}
                className={({ isActive }) =>
                  cn(
                    "block rounded-md px-3 py-2 text-sm transition-colors",
                    isActive
                      ? "bg-secondary font-medium"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
            {username && (
              <div className="mt-1 border-t px-3 pt-2 text-sm text-muted-foreground">
                Signed in as {username}
              </div>
            )}
          </nav>
        )}
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
