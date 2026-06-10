import Link from "next/link";
import { cn } from "@/lib/utils/cn";

const sections: { label: string; items: { href: string; label: string; hint?: string }[] }[] = [
  {
    label: "Overview",
    items: [{ href: "/", label: "Dashboard" }],
  },
  {
    label: "Reconciliation",
    items: [
      { href: "/statements", label: "Bank statements" },
      { href: "/statements/new", label: "+ Upload statement" },
      { href: "/accounts", label: "Bank accounts" },
      { href: "/rules", label: "Matching rules" },
    ],
  },
  {
    label: "Audit",
    items: [{ href: "/ai-audit", label: "AI usage" }],
  },
];

export function Sidebar({ currentPath }: { currentPath?: string }) {
  return (
    <nav className="flex h-full flex-col gap-6 p-5">
      <div>
        <Link href="/" className="block">
          <div className="text-base font-semibold tracking-tight text-ink-900">recon</div>
          <div className="text-[11px] uppercase tracking-wider text-ink-500">
            AI-assisted bank reconciliation
          </div>
          <div className="mt-1 text-[10px] text-ink-400">
            companion to <span className="font-mono">ledger-core</span>
          </div>
        </Link>
      </div>
      <div className="flex flex-col gap-5">
        {sections.map((section) => (
          <div key={section.label}>
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-400">
              {section.label}
            </div>
            <ul className="flex flex-col gap-0.5">
              {section.items.map((item) => {
                const active = currentPath === item.href;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={cn(
                        "flex items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors",
                        active ? "bg-ink-900 text-white" : "text-ink-700 hover:bg-ink-100"
                      )}
                    >
                      <span>{item.label}</span>
                      {item.hint && (
                        <span className="text-[10px] uppercase tracking-wide opacity-70">
                          {item.hint}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
