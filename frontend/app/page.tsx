"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Dashboard from "@/components/dashboard/Dashboard";
import { getValidToken, clearSession } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

function SplashScreen({ progress }: { progress: number }) {
  const pct = Math.min(100, Math.max(0, progress));
  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-slate-50">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/cover.jpeg"
        alt="ThreadNotes"
        className="absolute inset-0 h-full w-full object-cover"
      />

      {/* SilkOptima logo → progress bar → loading label, stacked in the empty
          space the cover art leaves below the Threadnotes divider. */}
      <div className="absolute bottom-[9%] left-1/2 flex w-80 max-w-[85%] -translate-x-1/2 flex-col items-center gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo.png"
          alt="SilkOptima"
          className="h-auto w-64 max-w-full object-contain"
        />
        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200/80 shadow-sm">
          <div
            className="h-full rounded-full bg-linear-to-r from-[#2FB5AA] to-[#2E6DBE] transition-all duration-300 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold tracking-wide text-slate-500">
            Loading workspace
          </p>
          <span className="flex gap-1">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400 [animation-delay:150ms]" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400 [animation-delay:300ms]" />
          </span>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const router = useRouter();
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [booting, setBooting] = useState(true);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let settled = false;
    setProgress(12);

    // Real milestone: wake the backend. Progress steps as boot work completes.
    const ping = fetch(`${API_URL}/`, { cache: "no-store" })
      .then(() => {})
      .catch(() => {});
    const shellStep = setTimeout(
      () => setProgress((p) => Math.max(p, 45)),
      250,
    );
    void ping.then(() => setProgress((p) => Math.max(p, 80)));

    const decide = () => {
      if (settled) return;
      settled = true;
      setProgress(100);
      if (!getValidToken()) {
        clearSession();
        router.replace("/auth");
      } else {
        setIsAuthorized(true);
      }
      // Let the bar visibly reach 100% before the splash unmounts.
      setTimeout(() => setBooting(false), 300);
    };

    // Decide as soon as the ping settles (with a small settle delay), and a hard
    // cap so a hung backend never blocks boot.
    void ping.then(() => setTimeout(decide, 400));
    const maxWait = setTimeout(decide, 2500);

    return () => {
      clearTimeout(shellStep);
      clearTimeout(maxWait);
    };
  }, [router]);

  if (booting || !isAuthorized) {
    return <SplashScreen progress={progress} />;
  }

  return <Dashboard />;
}
