import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { Copilot } from './pages/Copilot';
import { Logs } from './pages/Logs';
import { Documents } from './pages/Documents';
import { Settings } from './pages/Settings';
import { Tickets } from './pages/Tickets';
import { Investigations } from './pages/Investigations';
import { InvestigationDetailPage } from './pages/InvestigationDetail';
import { Operations } from './pages/Operations';
import { Search } from './pages/Search';
import { Admin } from './pages/Admin';
import { Login } from './pages/Login';
import { useAuth } from './lib/auth';
import { AuthProvider } from './lib/authProvider';
import { ThemeProvider } from './lib/themeProvider';
import { Icon } from './components/ui';

function BootScreen() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background">
      <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-on-primary">
        <Icon name="troubleshoot" size={26} />
      </div>
      <div className="text-center">
        <div className="font-display text-[22px] font-bold tracking-tight text-on-surface">OpsPilot AI</div>
        <div className="mt-1 font-mono text-label-sm uppercase tracking-[0.16em] text-outline">
          Restoring organization session…
        </div>
      </div>
    </div>
  );
}

function Shell() {
  const { ready, token } = useAuth();

  if (!ready) return <BootScreen />;
  if (!token) return <Login />;

  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="copilot" element={<Copilot />} />
        <Route path="logs" element={<Logs />} />
        <Route path="tickets" element={<Tickets />} />
        <Route path="investigations" element={<Investigations />} />
        <Route path="investigations/:id" element={<InvestigationDetailPage />} />
        <Route path="operations" element={<Operations />} />
        <Route path="documents" element={<Documents />} />
        <Route path="search" element={<Search />} />
        <Route path="admin" element={<Admin />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <Shell />
      </AuthProvider>
    </ThemeProvider>
  );
}
