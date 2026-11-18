import { useEffect, useState } from 'react';
import { apiCall } from '../lib/api';

interface Ticket {
  id: string;
  title: string;
  description?: string;
  priority: string;
  status: string;
}

export function Tickets() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [ingestText, setIngestText] = useState('');
  const [ingesting, setIngesting] = useState(false);

  const fetchTickets = async () => {
    setLoading(true);
    try {
      const data = await apiCall('/tickets');
      setTickets(data as Ticket[]);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchTickets(); }, []);

  const handleIngest = async () => {
    setIngesting(true);
    try {
      let payload: unknown = ingestText;
      try {
        const parsed = JSON.parse(ingestText);
        payload = parsed;
      } catch {
        payload = { csv: ingestText };
      }
      await apiCall('/tickets/ingest', { method: 'POST', body: JSON.stringify(payload) });
      setIngestText('');
      await fetchTickets();
    } catch (e) {
      console.error(e);
    } finally {
      setIngesting(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8 bg-background custom-scrollbar w-full pb-24">
      <div className="max-w-7xl mx-auto space-y-6">
        <h2 className="font-headline-xl text-[28px] md:text-[36px] text-on-surface font-extrabold tracking-tight leading-none">Tickets</h2>
        <div className="bg-surface-container-low border border-outline-variant/15 rounded-2xl p-4 space-y-3">
          <textarea
            value={ingestText}
            onChange={(e) => setIngestText(e.target.value)}
            placeholder='Paste JSON array or CSV (title,description,status,priority)'
            className="w-full bg-surface border border-outline-variant/20 rounded-xl p-3 text-on-surface font-body-sm min-h-[120px]"
          />
          <button onClick={handleIngest} disabled={ingesting} className="bg-primary text-on-primary px-4 py-2 rounded-xl font-bold disabled:opacity-50">
            {ingesting ? 'Ingesting...' : 'Ingest Tickets'}
          </button>
        </div>
        {loading ? <div>Loading...</div> : (
          <div className="space-y-2">
            {tickets.map((t) => (
              <div key={t.id} className="bg-surface-container-low border border-outline-variant/15 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-bold text-on-surface">{t.title}</span>
                  <span className="text-xs px-2 py-0.5 rounded bg-surface-variant text-on-surface-variant">{t.priority}</span>
                  <span className="text-xs px-2 py-0.5 rounded bg-surface-variant text-on-surface-variant">{t.status}</span>
                </div>
                {t.description && <p className="text-sm text-on-surface-variant/70">{t.description}</p>}
              </div>
            ))}
            {tickets.length === 0 && <div className="text-on-surface-variant/60">No tickets.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
