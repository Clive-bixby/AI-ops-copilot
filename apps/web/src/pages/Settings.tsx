import { Link } from 'react-router-dom';

export function Settings() {
  const handleLogout = () => {
    localStorage.removeItem('jwt');
    localStorage.removeItem('orgId');
    window.location.reload();
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8 bg-background custom-scrollbar w-full pb-24">
      <div className="max-w-3xl mx-auto space-y-6">
        <h2 className="font-headline-xl text-[28px] md:text-[36px] text-on-surface font-extrabold tracking-tight leading-none">
          Settings
        </h2>
        <div className="bg-surface-container-low border border-outline-variant/15 rounded-2xl p-6 space-y-4">
          <p className="font-body-md text-on-surface-variant/70">
            Manage your session and account.
          </p>
          <div className="flex gap-3">
            <Link to="/admin" className="bg-surface-variant text-on-surface px-6 py-3 rounded-xl font-body-md font-bold transition-all">
              Admin Panel
            </Link>
            <button
              onClick={handleLogout}
              className="bg-error hover:bg-error/90 text-on-error px-6 py-3 rounded-xl font-body-md font-bold transition-all"
            >
              Log out / Switch user
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
