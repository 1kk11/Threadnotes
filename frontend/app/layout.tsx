import type { Metadata, Viewport } from "next";
import "./globals.css";
import AuthInterceptor from "@/components/AuthInterceptor";

export const metadata: Metadata = {
  title: "ThreadNotes – AI Real-time Meeting Assistant",
  description: "Capture, transcribe, and summarize your meetings in real time.",
};

export const viewport: Viewport = {
  themeColor: "#4F46E5",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased bg-[var(--bg-primary)] text-[var(--text-primary)] m-0 p-0 overflow-hidden">
        <div className="w-full h-[100dvh]">
          {/* 👈 ProtectedRoute removed from RootLayout. It should only wrap specific pages. */}
          <AuthInterceptor />
          {children}
        </div>
      </body>
    </html>
  );
}
