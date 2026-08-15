"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function NavigationListener() {
  const router = useRouter();

  useEffect(() => {
    if (typeof window !== "undefined" && (window as any).electronAPI?.onNavigate) {
      const unsubscribe = (window as any).electronAPI.onNavigate((route: string) => {
        // Instead of router.push (which crashes static export apps if route is missing),
        // we dispatch a custom event that Dashboard.tsx can listen to.
        const event = new CustomEvent("app-navigate", { detail: { route } });
        window.dispatchEvent(event);
      });
      return unsubscribe;
    }
  }, [router]);

  return null;
}
