"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Dashboard from "@/components/dashboard/Dashboard";
import { getValidToken, clearSession } from "@/lib/auth";

export default function Home() {
  const router = useRouter();
  const [isAuthorized, setIsAuthorized] = useState(false);

  useEffect(() => {
    if (!getValidToken()) {
      clearSession();
      router.replace("/auth");
    } else {
      setIsAuthorized(true);
    }
  }, [router]);

  if (!isAuthorized) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-4">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent"></div>
          <p className="animate-pulse font-bold tracking-wide text-indigo-600">
            Loading ThreadNotes...
          </p>
        </div>
      </div>
    );
  }

  return <Dashboard />;
}
