"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Dashboard from "@/components/dashboard/Dashboard";
import { getValidToken, clearSession } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

function SplashScreen() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-7 bg-slate-50">
      <div className="relative flex h-20 w-20 items-center justify-center">
        <span className="absolute inset-0 animate-ping rounded-2xl bg-violet-400/30" />
        <span className="absolute inset-0 rounded-2xl bg-violet-500/10 blur-xl" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/app-icon.ico"
          alt="ThreadNotes"
          className="relative h-16 w-16 rounded-2xl shadow-lg shadow-violet-500/30"
        />
      </div>

      <div className="flex flex-col items-center gap-4">
        <h1 className="bg-linear-to-r from-violet-600 to-blue-600 bg-clip-text text-2xl font-black tracking-tight text-transparent">
          ThreadNotes
        </h1>

        <div className="relative h-1 w-44 overflow-hidden rounded-full bg-slate-200">
          <div className="absolute inset-y-0 left-0 w-1/3 animate-[loadbar_1.1s_ease-in-out_infinite] rounded-full bg-linear-to-r from-violet-500 to-blue-500" />
        </div>

        <p className="animate-pulse text-xs font-medium tracking-wide text-slate-400">
          Starting up…
        </p>
      </div>
    </div>
  );
}

export default function Home() {
  const router = useRouter();
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    fetch(`${API_URL}/`, { cache: "no-store" }).catch(() => {});

    const decide = () => {
      if (!getValidToken()) {
        clearSession();
        router.replace("/auth");
      } else {
        setIsAuthorized(true);
      }
      setBooting(false);
    };

    const t = setTimeout(decide, 700);
    return () => clearTimeout(t);
  }, [router]);

  if (booting || !isAuthorized) {
    return <SplashScreen />;
  }

  return <Dashboard />;
}
