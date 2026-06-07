import React from 'react';
import { Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { Copilot } from './pages/Copilot';
import { Logs } from './pages/Logs';
import { Documents } from './pages/Documents';
import { initAuth } from './lib/api';

function App() {
  const [isAuthReady, setIsAuthReady] = React.useState(false);

  React.useEffect(() => {
    initAuth().then(() => setIsAuthReady(true));
  }, []);

  if (!isAuthReady) {
    return <div className="h-screen w-screen bg-background flex items-center justify-center text-primary font-body-md">Initializing...</div>;
  }

  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="copilot" element={<Copilot />} />
        <Route path="logs" element={<Logs />} />
        <Route path="documents" element={<Documents />} />
      </Route>
    </Routes>
  );
}

export default App;
