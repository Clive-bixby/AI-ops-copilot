import { NavLink } from 'react-router-dom';
import clsx from 'clsx';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { Icon } from './ui';
import { initials, titleCase } from '../lib/format';

const navItems = [
  { icon: 'grid_view', label: 'Command Center', to: '/' },
  { icon: 'neurology', label: 'AI Copilot', to: '/copilot' },
  { icon: 'terminal', label: 'Logs Explorer', to: '/logs' },
  { icon: 'confirmation_number', label: 'Tickets & Incidents', to: '/tickets' },
  { icon: 'radar', label: 'Investigations', to: '/investigations' },
  { icon: 'library_books', label: 'Knowledge & Docs', to: '/documents' },
  { icon: 'manage_search', label: 'Semantic Search', to: '/search' },
  { icon: 'admin_panel_settings', label: 'Admin & Roles', to: '/admin', adminOnly: true },
  { icon: 'tune', label: 'Settings', to: '/settings' },
];

export function SideNavBar({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { session, logout, role, isAdmin } = useAuth();
  const { theme, setTheme } = useTheme();

  const visibleItems = navItems.filter((item) => !item.adminOnly || isAdmin);
  const email = session?.user.email ?? 'Signed in';
  const roleLabel = titleCase(role ?? 'member');

  return (
    <nav
      aria-label="Primary navigation"
      className={clsx(
        'fixed inset-y-0 left-0 z-50 flex w-[260px] flex-col border-r border-outline-variant bg-surface transition-transform duration-300 ease-out md:w-[248px] md:translate-x-0',
        isOpen ? 'translate-x-0' : '-translate-x-full'
      )}
    >
      <div className="flex h-14 items-center justify-between border-b border-line px-md">
        <NavLink to="/" onClick={onClose} className="flex items-center gap-2" aria-label="OpsPilot AI home">
          <span className="flex h-8 w-8 items-center justify-center rounded bg-primary text-on-primary">
            <Icon name="troubleshoot" size={18} />
          </span>
          <span className="font-display text-[20px] font-bold tracking-tight text-on-surface">
            OpsPilot
          </span>
          <span className="rounded border border-outline-variant px-1 py-0.5 font-mono text-[9px] font-medium uppercase tracking-wider text-outline">
            AI
          </span>
        </NavLink>
        <button
          onClick={onClose}
          className="rounded p-1 text-outline transition-colors hover:bg-surface-low hover:text-on-surface md:hidden"
          aria-label="Close navigation"
        >
          <Icon name="close" size={20} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-sm py-md">
        <div className="px-2 pb-2 font-mono text-label-sm uppercase tracking-[0.16em] text-outline">
          Core Navigation
        </div>
        <div className="space-y-0.5">
          {visibleItems.map((item) => (
            <NavLink
              key={item.label}
              to={item.to}
              end={item.to === '/'}
              onClick={onClose}
              className={({ isActive }) =>
                clsx(
                  'group relative flex items-center gap-2.5 rounded px-2.5 py-2 font-label-lg text-label-lg transition-colors',
                  isActive
                    ? 'bg-surface-container font-semibold text-primary'
                    : 'text-on-surface-variant hover:bg-surface-low hover:text-on-surface'
                )
              }
            >
              {({ isActive }) => (
                <>
                  {isActive ? (
                    <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-r bg-primary" />
                  ) : null}
                  <Icon
                    name={item.icon}
                    size={18}
                    filled={isActive}
                    className={isActive ? 'text-primary' : 'text-outline group-hover:text-on-surface-variant'}
                  />
                  <span className="truncate">{item.label}</span>
                </>
              )}
            </NavLink>
          ))}
        </div>
      </div>

      <div className="border-t border-line p-md">
        <div className="mb-3 grid grid-cols-2 gap-0.5 rounded border border-outline-variant bg-surface-low p-0.5">
          {(['light', 'dark'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setTheme(mode)}
              aria-pressed={theme === mode}
              className={clsx(
                'flex items-center justify-center gap-1 rounded-sm py-1 font-mono text-label-sm transition-all',
                theme === mode
                  ? 'bg-surface text-on-surface shadow-sm'
                  : 'text-outline hover:text-on-surface-variant'
              )}
            >
              <Icon name={mode === 'light' ? 'light_mode' : 'dark_mode'} size={13} />
              {mode === 'light' ? 'Light Mode' : 'Dark'}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 rounded border border-outline-variant/60 bg-surface-low px-2 py-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-primary-fixed font-mono text-[11px] font-bold text-primary">
            {initials(email)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-label-lg text-label-lg text-on-surface">{email}</div>
            <div className="font-mono text-label-sm uppercase tracking-wider text-outline">
              {roleLabel}
            </div>
          </div>
          <button
            onClick={logout}
            title="Sign out"
            aria-label="Sign out"
            className="rounded p-1 text-outline transition-colors hover:bg-surface-container hover:text-error"
          >
            <Icon name="logout" size={16} />
          </button>
        </div>
      </div>
    </nav>
  );
}
