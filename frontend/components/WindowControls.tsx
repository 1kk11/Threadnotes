"use client";
import { Minus, Square, X } from "lucide-react";

export default function WindowControls() {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!api?.windowClose) return null;

  return (
    <div className="app-no-drag flex items-center">
      <button
        type="button"
        aria-label="Minimize"
        onClick={() => api.windowMinimize?.()}
        className="flex h-10 w-11 items-center justify-center text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-800"
      >
        <Minus className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label="Maximize"
        onClick={() => api.windowMaximizeToggle?.()}
        className="flex h-10 w-11 items-center justify-center text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-800"
      >
        <Square className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label="Close"
        onClick={() => api.windowClose?.()}
        className="flex h-10 w-11 items-center justify-center text-slate-500 transition-colors hover:bg-red-500 hover:text-white"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
