import { Plus } from "lucide-react";

type HeaderProps = {
  title?: string;
  onNewConversation?: () => void;
};

export default function Header({
  title = "Session Command",
  onNewConversation,
}: HeaderProps) {
  return (
    <header className="flex items-center justify-between">
      <h1 className="text-3xl font-bold tracking-tight text-slate-900">
        {title}
      </h1>

      <button
        onClick={onNewConversation}
        className="flex items-center gap-2 rounded-full bg-linear-to-r from-violet-500 to-blue-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-violet-500/25 transition-all hover:from-violet-600 hover:to-blue-600 active:scale-[0.98]"
      >
        <Plus className="h-4 w-4" strokeWidth={2.5} />
        New Conversation
      </button>
    </header>
  );
}
