"use client";
import { CheckCircle2 } from "lucide-react";

type InfoModalProps = {
  open: boolean;
  title: string;
  message: string;
  buttonLabel?: string;
  onClose: () => void;
};

export default function InfoModal({
  open,
  title,
  message,
  buttonLabel = "Continue",
  onClose,
}: InfoModalProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-3xl border border-white/60 bg-white p-7 text-center shadow-2xl">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full border border-emerald-100 bg-emerald-50">
          <CheckCircle2 className="h-6 w-6 text-emerald-500" />
        </div>
        <h3 className="text-xl font-bold text-slate-900">{title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-slate-500">{message}</p>
        <button
          onClick={onClose}
          className="mt-6 w-full rounded-xl bg-indigo-600 py-3 text-sm font-bold text-white transition-colors hover:bg-indigo-700"
        >
          {buttonLabel}
        </button>
      </div>
    </div>
  );
}
