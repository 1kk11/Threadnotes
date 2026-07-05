"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Dashboard from "@/components/dashboard/Dashboard";
import { getValidToken, clearSession } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

function SplashScreen() {
  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-slate-50">
      {/* Full-screen branding cover (public/cover.jpeg). */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/cover.jpeg"
        alt="ThreadNotes"
        className="absolute inset-0 h-full w-full object-cover"
      />

      <div className="absolute bottom-10 left-1/2 flex -translate-x-1/2 flex-col items-center gap-3">
        <div className="relative h-1 w-44 overflow-hidden rounded-full bg-white/60 shadow-sm">
          <div className="absolute inset-y-0 left-0 w-1/3 animate-[loadbar_1.1s_ease-in-out_infinite] rounded-full bg-linear-to-r from-[#2FB5AA] to-[#2E6DBE]" />
        </div>
        <p className="animate-pulse text-xs font-semibold tracking-wide text-slate-500">
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
