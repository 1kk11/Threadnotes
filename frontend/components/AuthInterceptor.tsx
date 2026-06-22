"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AuthInterceptor() {
  const router = useRouter();

  useEffect(() => {
    if (typeof window === "undefined") return;

    const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
    const originalFetch = window.fetch.bind(window);
    let redirecting = false;

    const urlOf = (input: RequestInfo | URL): string => {
      if (typeof input === "string") return input;
      if (input instanceof URL) return input.href;
      if (input instanceof Request) return input.url;
      return String(input);
    };

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await originalFetch(input as any, init);
      try {
        const url = urlOf(input);
        const isBackend = url.startsWith(API_URL);
        const isAuthRoute = /\/(login|signup|forgot-password|reset-password|send-signup-otp|verify-signup-otp)/.test(
          url,
        );
        const onAuthScreen = window.location.pathname.startsWith("/auth");

        if (
          res.status === 401 &&
          isBackend &&
          !isAuthRoute &&
          !onAuthScreen &&
          !redirecting
        ) {
          redirecting = true;
          localStorage.removeItem("token");
          localStorage.removeItem("userName");
          router.push("/auth");
        }
      } catch {}
      return res;
    };

    return () => {
      window.fetch = originalFetch;
    };
  }, [router]);

  return null;
}
