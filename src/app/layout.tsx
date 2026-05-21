import type { Metadata } from "next";
import { Sidebar } from "@/components/nav/sidebar";
import "./globals.css";

export const metadata: Metadata = {
  title: "recon",
  description: "AI-assisted bank reconciliation on the ledger-core substrate",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="grid min-h-screen grid-cols-[260px_1fr] bg-ink-50">
          <aside className="border-r border-ink-200 bg-white">
            <Sidebar />
          </aside>
          <main className="flex flex-col">
            <header className="border-b border-ink-200 bg-white px-8 py-3">
              <h1 className="text-lg font-semibold text-ink-900">Reconciliation</h1>
              <p className="text-xs text-ink-500">
                AI suggests; humans approve; ledger-core posts. Recon never writes the GL directly.
              </p>
            </header>
            <div className="flex-1 overflow-y-auto px-8 py-6">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
