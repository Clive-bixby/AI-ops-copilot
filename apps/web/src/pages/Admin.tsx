import { useEffect, useState } from 'react';
import { apiCall } from '../lib/api';

export function Admin() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiCall('/admin-test').then(setData).catch((e) => setError(e.message));
  }, []);

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8 bg-background custom-scrollbar w-full pb-24">
      <div className="max-w-3xl mx-auto space-y-6">
        <h2 className="font-headline-xl text-[28px] md:text-[36px] text-on-surface font-extrabold tracking-tight leading-none">Admin</h2>
        <div className="bg-surface-container-low border border-outline-variant/15 rounded-2xl p-6">
          {error && <div className="text-error">{error}</div>}
          {data && (
            <pre className="text-sm text-on-surface whitespace-pre-wrap">{JSON.stringify(data, null, 2)}</pre>
          )}
          {!data && !error && <div>Loading...</div>}
        </div>
      </div>
    </div>
  );
}
