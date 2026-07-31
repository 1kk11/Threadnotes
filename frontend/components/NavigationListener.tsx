"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function NavigationListener() {
  const router = useRouter();

  useEffect(() => {
    if (typeof window !== "undefined" && (window as any).electronAPI?.onNavigate) {
      const unsubscribe = (window as any).electronAPI.onNavigate((route: string) => {
        router.push(route);
      });
      return unsubscribe;
    }
  }, [router]);

  return null;
}
