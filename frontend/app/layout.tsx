import type { Metadata, Viewport } from "next";
import { Sora } from "next/font/google";
import "./globals.css";
import AuthInterceptor from "@/components/AuthInterceptor";
// Global state wrappers
import { GlobalAudioProvider } from "@/components/GlobalAudioProvider";
import { GlobalRecordingProvider } from "@/components/GlobalRecordingProvider";

const sora = Sora({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
  variable: "--font-sora",
});

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
    <html lang="en" className={sora.variable}>
      <body className="m-0 overflow-hidden bg-[var(--bg-primary)] p-0 font-sans antialiased text-[var(--text-primary)]">
        {/* Global providers wrap kiye hain taaki recording aur audio persist kare[cite: 10] */}
        <GlobalAudioProvider>
          <GlobalRecordingProvider>
            {/* Fixed viewport shell: exactly one screen tall/wide, clipped.
                Every page mounts inside this and manages its own inner scroll. */}
            <div className="h-[100dvh] w-screen overflow-hidden">
              <AuthInterceptor />
              {children}
            </div>
          </GlobalRecordingProvider>
        </GlobalAudioProvider>
      </body>
    </html>
  );
}