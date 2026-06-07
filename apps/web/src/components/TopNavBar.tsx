import { useLocation } from 'react-router-dom';
import clsx from 'clsx';

interface TopNavBarProps {
  onMenuClick: () => void;
}

export function TopNavBar({ onMenuClick }: TopNavBarProps) {
  const location = useLocation();
  const isCopilot = location.pathname === '/copilot';

  const getPageTitle = () => {
    switch (location.pathname) {
      case '/': return 'Dashboard';
      case '/copilot': return 'AI Copilot';
      case '/documents': return 'Documents';
      case '/logs': return 'Logs';
      default: return 'AI Ops Copilot';
    }
  };

  return (
    <header className="flex justify-between items-center w-full px-4 md:px-8 h-16 bg-surface-container border-b border-outline-variant/20 z-30 shrink-0 sticky top-0 backdrop-blur-md bg-opacity-80">
      <div className="flex items-center gap-md w-full max-w-xl">
        {/* Mobile Menu Button */}
        <button 
          onClick={onMenuClick}
          className="md:hidden p-1.5 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-variant transition-all mr-2"
        >
          <span className="material-symbols-outlined text-[24px]">menu</span>
        </button>
        
        {/* Page Title for Desktop */}
        <div className="hidden md:block mr-6">
          <span className="font-headline-lg text-headline-lg text-on-surface font-semibold tracking-tight">
            {getPageTitle()}
          </span>
        </div>

        {/* Search Bar */}
        <div className={clsx("relative w-full max-w-md hidden sm:block", isCopilot && "sm:max-w-xs")}>
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant/70 text-[18px]">
            search
          </span>
          <input
            className="w-full bg-surface border border-outline-variant/30 rounded-xl py-1.5 pl-10 pr-4 font-body-sm text-body-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 transition-all"
            placeholder={isCopilot ? "Search sources..." : "Search operational data..."}
            type="text"
          />
        </div>
      </div>
      
      <div className="flex items-center gap-4">
        {/* Environment status chip */}
        <div className="hidden lg:flex items-center gap-2 bg-background border border-outline-variant/15 px-3 py-1.5 rounded-xl">
          <span className="w-2 h-2 rounded-full bg-[#4ade80] animate-pulse"></span>
          <span className="font-code-sm text-code-sm text-on-surface-variant/80">ENV: <span className="text-on-surface font-medium">prod-us-east-1</span></span>
        </div>

        <div className="flex items-center gap-2 text-on-surface-variant border-l border-outline-variant/10 pl-4">
          <button className="p-2 hover:text-on-surface hover:bg-surface-variant/40 transition-all rounded-xl relative">
            <span className="material-symbols-outlined text-[20px]">notifications</span>
            <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-primary rounded-full"></span>
          </button>
          
          <button className="p-2 hover:text-on-surface hover:bg-surface-variant/40 transition-all rounded-xl hidden sm:block">
            <span className="material-symbols-outlined text-[20px]">help</span>
          </button>
          
          <button className="p-1.5 ml-1 hover:bg-surface-variant/40 transition-all rounded-xl flex items-center gap-2 border border-transparent hover:border-outline-variant/20">
            <div className="w-7 h-7 rounded-lg bg-primary-fixed-dim/15 text-primary flex items-center justify-center font-bold text-xs uppercase border border-primary/20">
              OP
            </div>
          </button>
        </div>
      </div>
    </header>
  );
}
