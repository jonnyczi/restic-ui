import { Link } from "react-router-dom";

export default function NotFoundPage() {
  return (
    <div className="rounded-lg border border-dashed p-12 text-center">
      <p className="font-medium">Page not found</p>
      <p className="mt-1 text-sm text-muted-foreground">
        There's nothing at this address. Back to the{" "}
        <Link className="underline" to="/">
          dashboard
        </Link>
        .
      </p>
    </div>
  );
}
