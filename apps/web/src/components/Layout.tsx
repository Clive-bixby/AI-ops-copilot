import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { SideNavBar } from './SideNavBar';
import { TopNavBar } from './TopNavBar';

export function Layout() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background">
      {isSidebarOpen ? (
        <button
          aria-label="Close navigation overlay"
          className="fixed inset-0 z-40 bg-[rgb(17_24_39/0.45)] md:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      ) : null}

      <SideNavBar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />

      <div className="flex min-h-screen flex-col md:pl-[248px]">
        <TopNavBar onMenuClick={() => setIsSidebarOpen(true)} />
        <main className="mx-auto w-full max-w-content flex-1 px-4 py-5 sm:px-6 lg:px-margin-desktop lg:py-6">
          <Outlet />
        </main>
        <footer className="mx-auto flex w-full max-w-content flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3 font-mono text-[10px] uppercase tracking-wider text-outline sm:px-6 lg:px-margin-desktop">
          <span>OpsPilot AI · Grounded operational intelligence</span>
          <span className="flex items-center gap-1.5">
            <span className="h-1 w-1 rounded-full bg-outline" />
            Organization-scoped retrieval · pgvector
          </span>
        </footer>
      </div>
    </div>
  );
}
