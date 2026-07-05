import type { Metadata, Viewport } from "next";
import { Sora } from "next/font/google";
import "./globals.css";
import AuthInterceptor from "@/components/AuthInterceptor";
import WindowControls from "@/components/WindowControls";
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
        <GlobalAudioProvider>
          <GlobalRecordingProvider>
            <div className="flex h-dvh w-screen flex-col overflow-hidden">
              <div className="app-drag flex h-10 shrink-0 select-none items-center justify-end bg-[#E8F7F6]">
                <WindowControls />
              </div>
              <div className="relative min-h-0 w-full flex-1 overflow-hidden">
                <AuthInterceptor />
                {children}
              </div>
            </div>
          </GlobalRecordingProvider>
        </GlobalAudioProvider>
      </body>
    </html>
  );
}