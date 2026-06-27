"use client";
import { useEffect } from "react";
import { X } from "lucide-react";
import Sidebar, { type DashboardView } from "./Sidebar";

type MobileSidebarProps = {
  open: boolean;
  onClose: () => void;
  activeView: DashboardView;
  onNavigate: (view: DashboardView) => void;
  meetingsCount?: number;
  userName?: string | null;
  onLogout?: () => void;
  onDeleteAccount?: () => void;
};

export default function MobileSidebar({
  open,
  onClose,
  ...sidebarProps
}: MobileSidebarProps) {
  // Close on Escape for keyboard/accessibility.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <div
      className={`fixed inset-0 z-200 lg:hidden ${open ? "" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity duration-300 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />

      {/* Sliding drawer */}
      <div
        role="dialog"
        aria-modal="true"
        className={`absolute inset-y-0 left-0 flex w-72 max-w-[85vw] transform shadow-2xl transition-transform duration-300 ease-out ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Sidebar
          {...sidebarProps}
          className="flex h-full w-full"
          onItemSelect={onClose}
        />
        <button
          onClick={onClose}
          aria-label="Close menu"
          className="absolute right-3 top-4 flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-white/70 hover:text-slate-800"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
