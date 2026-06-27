import {
  FileText,
  LayoutDashboard,
  CalendarDays,
  LogOut,
  Trash2,
} from "lucide-react";

export type DashboardView = "dashboard" | "meetings";

type SidebarProps = {
  activeView: DashboardView;
  onNavigate: (view: DashboardView) => void;
  meetingsCount?: number;
  userName?: string | null;
  onLogout?: () => void;
  onDeleteAccount?: () => void;
  /** Controls display + width per context (desktop rail vs mobile drawer). */
  className?: string;
  /** Fired after any nav/action — lets the mobile drawer close itself. */
  onItemSelect?: () => void;
};

export default function Sidebar({
  activeView,
  onNavigate,
  meetingsCount = 0,
  userName,
  onLogout,
  onDeleteAccount,
  className,
  onItemSelect,
}: SidebarProps) {
  const navBase =
    "flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm transition-colors";
  const navActive = "bg-white/70 font-semibold text-slate-800 shadow-sm ring-1 ring-white/80";
  const navIdle = "font-medium text-slate-500 hover:bg-white/50 hover:text-slate-800";

  const go = (view: DashboardView) => {
    onNavigate(view);
    onItemSelect?.();
  };

  return (
    <aside
      className={`${className ?? "flex w-64"} min-h-0 shrink-0 flex-col border-r border-white/60 bg-white/50 backdrop-blur-xl`}
    >
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-linear-to-br from-violet-500 to-blue-500 shadow-md shadow-violet-500/30">
          <FileText className="h-5 w-5 text-white" strokeWidth={2.2} />
        </div>
        <span className="text-lg font-bold tracking-tight text-slate-900">
          ThreadNotes
        </span>
      </div>

      <nav className="flex flex-col gap-1 px-3 py-2">
        <button
          onClick={() => go("dashboard")}
          className={`${navBase} ${activeView === "dashboard" ? navActive : navIdle}`}
        >
          <LayoutDashboard
            className={`h-4.5 w-4.5 ${activeView === "dashboard" ? "text-violet-600" : ""}`}
          />
          Dashboard
        </button>

        <button
          onClick={() => go("meetings")}
          className={`${navBase} justify-between ${
            activeView === "meetings" ? navActive : navIdle
          }`}
        >
          <span className="flex items-center gap-3">
            <CalendarDays
              className={`h-4.5 w-4.5 ${activeView === "meetings" ? "text-violet-600" : ""}`}
            />
            MyMeetings
          </span>
          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-slate-200 px-1.5 text-[11px] font-bold text-slate-600">
            {meetingsCount}
          </span>
        </button>
      </nav>

      <div className="mt-auto border-t border-white/60 px-4 py-4">
        <div className="flex items-center gap-3">
          {userName ? (
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-linear-to-br from-slate-300 to-slate-400 text-xs font-bold text-white">
              {userName.charAt(0).toUpperCase()}
            </div>
          ) : (
            <div className="h-9 w-9 animate-pulse rounded-full bg-slate-200" />
          )}
          <div className="flex flex-1 flex-col">
            {userName ? (
              <span className="text-sm font-semibold text-slate-800">
                {userName}
              </span>
            ) : (
              <span className="h-3.5 w-24 animate-pulse rounded bg-slate-200" />
            )}
            <span className="mt-1 flex items-center gap-1.5 text-[11px] font-medium text-emerald-600">
              <span className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_6px] shadow-emerald-400" />
              Live
            </span>
          </div>
        </div>

        <button
          onClick={() => {
            onLogout?.();
            onItemSelect?.();
          }}
          className="mt-3 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm font-medium text-slate-500 transition-colors hover:bg-white/60 hover:text-slate-800"
        >
          <LogOut className="h-4.5 w-4.5" />
          Log out
        </button>

        <button
          onClick={() => {
            onDeleteAccount?.();
            onItemSelect?.();
          }}
          className="mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm font-medium text-red-500 transition-colors hover:bg-red-50 hover:text-red-600"
        >
          <Trash2 className="h-4.5 w-4.5" />
          Delete Account
        </button>
      </div>
    </aside>
  );
}
