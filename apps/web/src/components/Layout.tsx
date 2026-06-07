import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { SideNavBar } from './SideNavBar';
import { TopNavBar } from './TopNavBar';

export function Layout() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  return (
    <div className="flex min-h-screen overflow-hidden bg-background font-body-md text-body-md antialiased text-on-surface selection:bg-primary selection:text-on-primary">
      {/* Mobile Sidebar overlay */}
      {isSidebarOpen && (
        <div 
          className="fixed inset-0 bg-background/80 backdrop-blur-sm z-40 md:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Sidebar with toggle state for mobile */}
      <SideNavBar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />
      
      <div className="flex-1 flex flex-col md:ml-64 relative overflow-hidden h-screen">
        <TopNavBar onMenuClick={() => setIsSidebarOpen(true)} />
        <main className="flex-1 overflow-hidden bg-background relative flex flex-col">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
