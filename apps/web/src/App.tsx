import React from 'react';
import { Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { Copilot } from './pages/Copilot';
import { Logs } from './pages/Logs';
import { Documents } from './pages/Documents';
import { Settings } from './pages/Settings';
import { Tickets } from './pages/Tickets';
import { Search } from './pages/Search';
import { Admin } from './pages/Admin';
import { Login } from './pages/Login';
import { initAuth } from './lib/api';

function App() {
  const [isAuthReady, setIsAuthReady] = React.useState(false);
  const [isAuthenticated, setIsAuthenticated] = React.useState(false);

  const checkAuth = async () => {
    const auth = await initAuth();
    setIsAuthenticated(!!auth);
    setIsAuthReady(true);
  };

  React.useEffect(() => { checkAuth(); }, []);

  if (!isAuthReady) {
    return <div className="h-screen w-screen bg-background flex items-center justify-center text-primary font-body-md">Initializing...</div>;
  }

  if (!isAuthenticated) {
    return <Login onAuth={() => { setIsAuthenticated(true); }} />;
  }

  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="copilot" element={<Copilot />} />
        <Route path="logs" element={<Logs />} />
        <Route path="documents" element={<Documents />} />
<Route path="tickets" element={<Tickets />} />
<Route path="search" element={<Search />} />
<Route path="admin" element={<Admin />} />
<Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}

export default App;
