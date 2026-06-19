"use client";

import { useRouter, usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export default function ProtectedRoute({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem("token");

    if (!token && pathname !== "/auth") {
      setAuthorized(false);
      router.push("/auth");
    } else {
      setAuthorized(true);
    }
  }, [router, pathname]);

  if (!authorized && pathname !== "/auth") {
    return (
      <div className="w-full h-full flex items-center justify-center">
        Loading ThreadNotes...
      </div>
    );
  }

  return <>{children}</>;
}
