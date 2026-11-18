import { NavLink } from 'react-router-dom';
import clsx from 'clsx';

const navItems = [
  { icon: 'dashboard', label: 'Dashboard', to: '/' },
  { icon: 'psychology', label: 'AI Copilot', to: '/copilot' },
  { icon: 'description', label: 'Documents', to: '/documents' },
  { icon: 'confirmation_number', label: 'Tickets', to: '/tickets' },
  { icon: 'terminal', label: 'Logs', to: '/logs' },
  { icon: 'search', label: 'Search', to: '/search' },
  { icon: 'admin_panel_settings', label: 'Admin', to: '/admin' },
];

const bottomNavItems = [
  { icon: 'settings', label: 'Settings', to: '/settings' },
];

interface SideNavBarProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SideNavBar({ isOpen, onClose }: SideNavBarProps) {
  return (
    <nav className={clsx(
      "fixed left-0 top-0 h-full z-50 w-64 flex flex-col bg-surface-container border-r border-outline-variant/30 transition-transform duration-300 ease-in-out md:translate-x-0",
      isOpen ? "translate-x-0" : "-translate-x-full"
    )}>
      {/* Brand Header */}
      <div className="p-lg flex items-center justify-between border-b border-outline-variant/20 bg-surface-container-low">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center border border-primary/20 ai-glow">
            <span className="material-symbols-outlined text-primary text-[28px]" data-weight="fill">
              psychology
            </span>
          </div>
          <div>
            <h1 className="font-headline-lg-mobile text-[18px] font-extrabold text-on-surface tracking-tight leading-none">
              AI Ops Copilot
            </h1>
            <p className="font-label-caps text-[9px] text-primary uppercase mt-1 tracking-wider font-semibold">
              Operational Intel
            </p>
          </div>
        </div>
        <button 
          onClick={onClose}
          className="p-1 rounded-lg hover:bg-surface-variant text-on-surface-variant md:hidden transition-colors"
        >
          <span className="material-symbols-outlined">close</span>
        </button>
      </div>
      
      {/* Navigation Links */}
      <div className="flex-1 px-md py-6 space-y-2 overflow-y-auto custom-scrollbar bg-surface-container-low/50">
        <div className="px-3 mb-2">
          <span className="font-label-caps text-label-caps text-on-surface-variant/40 tracking-widest uppercase">Navigation</span>
        </div>
        {navItems.map((item) => (
          <NavLink
            key={item.label}
            to={item.to}
            onClick={onClose}
            className={({ isActive }) =>
              clsx(
                "flex items-center gap-3 px-4 py-3 rounded-xl font-body-sm text-body-sm transition-all duration-200 ease-in-out group relative",
                isActive
                  ? "bg-primary-container/10 text-primary border border-primary/20 font-semibold shadow-[inset_0_1px_1px_rgba(255,255,255,0.05)] shadow-primary/5"
                  : "text-on-surface-variant hover:bg-surface-variant/40 hover:text-on-surface border border-transparent"
              )
            }
          >
            {({ isActive }) => (
              <>
                {/* Active Indicator Line */}
                {isActive && (
                  <div className="absolute left-0 top-1/3 bottom-1/3 w-1 bg-primary rounded-r" />
                )}
                <span
                  className={clsx(
                    "material-symbols-outlined transition-colors duration-200",
                    isActive ? "text-primary" : "text-on-surface-variant/70 group-hover:text-primary"
                  )}
                  style={isActive ? { fontVariationSettings: "'FILL' 1" } : {}}
                >
                  {item.icon}
                </span>
                <span className="tracking-wide">{item.label}</span>
                {isActive && item.label === 'AI Copilot' && (
                  <span className="ml-auto w-2 h-2 rounded-full bg-[#4ade80] animate-pulse" />
                )}
              </>
            )}
          </NavLink>
        ))}
      </div>

      {/* Bottom Actions */}
      <div className="p-md border-t border-outline-variant/20 bg-surface-container">
        <div className="space-y-1">
          {bottomNavItems.map((item) => (
            <a
              key={item.label}
              href={item.to}
              className="flex items-center gap-3 px-4 py-2.5 rounded-xl text-on-surface-variant/80 hover:bg-surface-variant/40 hover:text-on-surface transition-all duration-150 group"
            >
              <span className="material-symbols-outlined text-on-surface-variant/60 group-hover:text-primary transition-colors">
                {item.icon}
              </span>
              <span className="font-body-sm text-body-sm font-medium tracking-wide">{item.label}</span>
            </a>
          ))}
        </div>
      </div>
    </nav>
  );
}
