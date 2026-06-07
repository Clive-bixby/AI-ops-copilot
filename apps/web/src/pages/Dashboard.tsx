import { useEffect, useState } from 'react';
import { apiCall } from '../lib/api';
import { useNavigate } from 'react-router-dom';

interface Log {
  id: string;
  level: string;
  message: string;
  timestamp: string;
}

interface Ticket {
  id: string;
  priority: string;
  title: string;
  status: string;
}

export function Dashboard() {
  const [logs, setLogs] = useState<Log[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [docsCount, setDocsCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [logsData, ticketsData, docsData] = await Promise.all([
          apiCall('/logs').catch(() => []),
          apiCall('/tickets').catch(() => []),
          apiCall('/documents').catch(() => []),
        ]);
        setLogs(logsData as Log[]);
        setTickets(ticketsData as Ticket[]);
        setDocsCount(docsData.length || 0);
      } catch (error) {
        console.error("Failed to load dashboard data", error);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const openTicketsCount = tickets.filter(t => t.status !== 'closed' && t.status !== 'resolved').length;
  const recentLogs = logs.slice(0, 4);
  
  const priorityDistribution = tickets.reduce((acc, t) => {
    acc[t.priority.toLowerCase()] = (acc[t.priority.toLowerCase()] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const getPercent = (count: number) => {
    if (tickets.length === 0) return '0%';
    return `${Math.round((count / tickets.length) * 100)}%`;
  };

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-background text-on-surface-variant font-body-md h-full w-full gap-4">
        <span className="material-symbols-outlined text-primary text-[48px] animate-spin">sync</span>
        <span className="font-medium tracking-wide">Syncing operational pipeline...</span>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 flex-1 flex flex-col gap-6 pb-24 overflow-y-auto custom-scrollbar bg-background">
      {/* Context Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-outline-variant/10 pb-6">
        <div>
          <h2 className="font-headline-xl text-[28px] md:text-[36px] text-on-surface font-extrabold tracking-tight leading-none">
            Good afternoon, Operator
          </h2>
          <p className="font-body-md text-on-surface-variant/70 mt-2">
            Continuous environment evaluation & alert analytics.
          </p>
        </div>
        <div className="flex items-center gap-3 bg-surface-container border border-outline-variant/15 px-4 py-2 rounded-xl self-start sm:self-center">
          <span className="relative flex h-3.5 w-3.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary/40 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-primary"></span>
          </span>
          <span className="font-code-sm text-code-sm text-on-surface-variant">
            COGNITIVE PIPELINE: <span className="text-on-surface font-semibold uppercase tracking-wide">ACTIVE</span>
          </span>
        </div>
      </div>

      {/* Metric Cards (Bento Grid Style) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Metric 1 */}
        <div className="bg-surface-container-low border border-outline-variant/15 p-6 rounded-2xl flex flex-col justify-between hover:border-outline-variant/30 transition-all group cursor-pointer" onClick={() => navigate('/documents')}>
          <div className="flex items-center justify-between mb-4">
            <span className="font-label-caps text-label-caps text-on-surface-variant/65 uppercase tracking-wider font-semibold">Knowledge Ingested</span>
            <div className="w-9 h-9 rounded-xl bg-surface-variant/40 flex items-center justify-center text-on-surface-variant group-hover:text-primary group-hover:bg-primary/5 transition-all">
              <span className="material-symbols-outlined text-[20px]">description</span>
            </div>
          </div>
          <div>
            <div className="font-headline-lg text-headline-lg text-on-surface tracking-tight font-black leading-none">{docsCount}</div>
            <p className="font-body-sm text-[12px] text-on-surface-variant/50 mt-1">Operational documents & runbooks</p>
          </div>
        </div>

        {/* Metric 2 */}
        <div className="bg-surface-container-low border border-outline-variant/15 p-6 rounded-2xl flex flex-col justify-between hover:border-outline-variant/30 transition-all group cursor-pointer" onClick={() => navigate('/logs')}>
          <div className="flex items-center justify-between mb-4">
            <span className="font-label-caps text-label-caps text-on-surface-variant/65 uppercase tracking-wider font-semibold">Log Volumetrics</span>
            <div className="w-9 h-9 rounded-xl bg-surface-variant/40 flex items-center justify-center text-on-surface-variant group-hover:text-primary group-hover:bg-primary/5 transition-all">
              <span className="material-symbols-outlined text-[20px]">terminal</span>
            </div>
          </div>
          <div>
            <div className="font-headline-lg text-headline-lg text-on-surface tracking-tight font-black leading-none">
              {logs.length} <span className="text-[14px] font-normal text-on-surface-variant/60">events</span>
            </div>
            <p className="font-body-sm text-[12px] text-on-surface-variant/50 mt-1">Aggregated platform log packets</p>
          </div>
        </div>

        {/* Metric 3 */}
        <div className="bg-surface-container-low border border-outline-variant/15 p-6 rounded-2xl flex flex-col justify-between hover:border-error/30 hover:shadow-lg hover:shadow-error/5 transition-all group relative overflow-hidden">
          <div className="absolute top-0 right-0 w-24 h-24 bg-error/5 blur-2xl rounded-full pointer-events-none"></div>
          <div className="flex items-center justify-between mb-4 relative z-10">
            <span className="font-label-caps text-label-caps text-on-surface-variant/65 uppercase tracking-wider font-semibold">Active Incidents</span>
            <div className="w-9 h-9 rounded-xl bg-error/10 flex items-center justify-center text-error">
              <span className="material-symbols-outlined text-[20px]" data-weight="fill">confirmation_number</span>
            </div>
          </div>
          <div className="relative z-10">
            <div className="font-headline-lg text-headline-lg text-error tracking-tight font-black leading-none">{openTicketsCount}</div>
            <p className="font-body-sm text-[12px] text-on-surface-variant/50 mt-1">Unresolved tickets needing response</p>
          </div>
        </div>

        {/* Metric 4 */}
        <div className="bg-surface-container-low border border-primary/20 p-6 rounded-2xl flex flex-col justify-between hover:shadow-lg hover:shadow-primary/5 transition-all group relative overflow-hidden ai-glow">
          <div className="absolute -right-4 -top-4 w-16 h-16 bg-primary/10 blur-xl rounded-full pointer-events-none"></div>
          <div className="flex items-center justify-between mb-4">
            <span className="font-label-caps text-label-caps text-primary uppercase tracking-wider font-semibold">AI Copilot Readiness</span>
            <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
              <span className="material-symbols-outlined text-[20px]" data-weight="fill">psychology</span>
            </div>
          </div>
          <div>
            <div className="font-headline-lg text-headline-lg text-primary tracking-tight font-black leading-none">Online</div>
            <p className="font-body-sm text-[12px] text-primary/60 mt-1">RAG engine primed for query</p>
          </div>
        </div>
      </div>

      {/* AI Insights Panel */}
      <div className="bg-gradient-to-br from-surface-container-low to-surface-container p-6 md:p-8 rounded-2xl border border-outline-variant/20 relative overflow-hidden group">
        {/* Subtle grid pattern background */}
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.01)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.01)_1px,transparent_1px)] bg-[size:20px_20px] pointer-events-none"></div>
        <div className="absolute -right-24 -top-24 w-80 h-80 bg-primary/10 blur-3xl rounded-full group-hover:bg-primary/15 transition-all duration-700 pointer-events-none"></div>
        
        <div className="relative z-10 flex flex-col lg:flex-row gap-6 items-start lg:items-center justify-between">
          <div className="flex-1 space-y-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center text-primary border border-primary/20">
                <span className="material-symbols-outlined text-[16px]" data-weight="fill">smart_toy</span>
              </div>
              <h3 className="font-label-caps text-label-caps font-bold text-primary tracking-widest uppercase">Operator Intelligence Module</h3>
            </div>
            <div>
              <p className="text-xl md:text-2xl font-bold text-on-surface tracking-tight">
                Anomalies and logs mapped against knowledge repositories.
              </p>
              <p className="font-body-md text-on-surface-variant/75 mt-2 max-w-4xl">
                The copilot has analyzed system states. You can ask questions to perform fast root cause diagnosis, auto-generate K8s runbooks, or filter errors dynamically based on ingest data.
              </p>
            </div>
          </div>
          <button 
            onClick={() => navigate('/copilot')}
            className="bg-primary hover:bg-primary/90 text-on-primary px-6 py-3.5 rounded-xl font-body-sm text-body-sm font-bold flex items-center justify-center gap-2 transition-all shadow-[0_4px_20px_rgba(192,193,255,0.15)] self-stretch lg:self-auto"
          >
            <span className="material-symbols-outlined text-[18px]">chat_bubble</span>
            Consult Copilot
          </button>
        </div>
      </div>

      {/* Split Layout Section */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 flex-1">
        {/* Left: Recent Activity (Logs) */}
        <div className="lg:col-span-7 bg-surface-container-low border border-outline-variant/15 rounded-2xl overflow-hidden flex flex-col hover:border-outline-variant/25 transition-all">
          <div className="p-5 border-b border-outline-variant/10 flex items-center justify-between bg-surface-container/40">
            <h3 className="font-body-md text-body-md font-bold text-on-surface flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-[20px]">history</span>
              Continuous Log Feed
            </h3>
            <button 
              onClick={() => navigate('/logs')}
              className="text-primary hover:text-primary/80 font-body-sm text-[12px] font-semibold flex items-center gap-1 transition-all"
            >
              Console View <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
            </button>
          </div>
          <div className="p-0 flex-1 overflow-y-auto divide-y divide-outline-variant/10">
            {recentLogs.length === 0 ? (
              <div className="p-8 text-on-surface-variant/60 font-body-sm text-center">No telemetry logs indexed.</div>
            ) : (
              recentLogs.map((log: Log) => (
                <div key={log.id} className="flex items-start gap-4 p-4 hover:bg-surface-container/30 transition-all group">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 ${log.level?.toLowerCase() === 'error' ? 'bg-error/10 text-error' : 'bg-surface-variant text-on-surface-variant/80'}`}>
                    <span className="material-symbols-outlined text-[16px]">{log.level?.toLowerCase() === 'error' ? 'warning' : 'terminal'}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1 gap-2">
                      <span className={`font-code-sm text-code-sm font-bold uppercase tracking-wider ${log.level?.toLowerCase() === 'error' ? 'text-error' : 'text-on-surface-variant'}`}>
                        {log.level || 'INFO'}
                      </span>
                      <span className="font-code-sm text-[11px] text-on-surface-variant/40">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <p className="font-code-sm text-body-sm text-on-surface/90 group-hover:text-primary transition-colors truncate">{log.message}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Right: Ticket Summary */}
        <div className="lg:col-span-5 bg-surface-container-low border border-outline-variant/15 rounded-2xl overflow-hidden flex flex-col hover:border-outline-variant/25 transition-all">
          <div className="p-5 border-b border-outline-variant/10 bg-surface-container/40">
            <h3 className="font-body-md text-body-md font-bold text-on-surface flex items-center gap-2 mb-4">
              <span className="material-symbols-outlined text-primary text-[20px]">analytics</span>
              Incident Matrix
            </h3>
            {/* Distribution Bar */}
            <div className="h-2.5 w-full rounded-full overflow-hidden flex bg-surface-variant/40">
              <div className="h-full bg-error" style={{ width: getPercent(priorityDistribution['critical'] || 0) }}></div>
              <div className="h-full bg-orange-400" style={{ width: getPercent(priorityDistribution['high'] || 0) }}></div>
              <div className="h-full bg-primary" style={{ width: getPercent(priorityDistribution['medium'] || 0) }}></div>
              <div className="h-full bg-on-surface-variant/30" style={{ width: getPercent(priorityDistribution['low'] || 0) }}></div>
            </div>
            <div className="flex justify-between mt-3 font-label-caps text-[10px] font-bold text-on-surface-variant/70 tracking-wider">
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-error"></span>CRIT ({priorityDistribution['critical'] || 0})</span>
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-orange-400"></span>HIGH ({priorityDistribution['high'] || 0})</span>
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-primary"></span>MED ({priorityDistribution['medium'] || 0})</span>
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-on-surface-variant/30"></span>LOW ({priorityDistribution['low'] || 0})</span>
            </div>
          </div>
          <div className="p-4 flex-1 flex flex-col gap-2 overflow-y-auto max-h-80 custom-scrollbar divide-y divide-outline-variant/5">
            {tickets.length === 0 ? (
              <div className="text-on-surface-variant/50 font-body-sm text-center py-8">No incident tickets logged.</div>
            ) : (
              tickets.slice(0, 5).map(ticket => (
                <div key={ticket.id} className="flex items-center justify-between p-3 rounded-xl border border-outline-variant/10 bg-surface-container/10 hover:bg-surface-variant/25 transition-all cursor-pointer group">
                  <div className="min-w-0 flex-1 pr-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`font-code-sm text-[10px] font-bold px-1.5 py-0.5 rounded ${ticket.priority?.toLowerCase() === 'critical' ? 'bg-error/15 text-error border border-error/10' : ticket.priority?.toLowerCase() === 'high' ? 'bg-orange-400/15 text-orange-400 border border-orange-400/10' : 'bg-primary/10 text-primary border border-primary/10'}`}>
                        {ticket.priority?.toUpperCase()}
                      </span>
                      <span className="font-code-sm text-[11px] text-on-surface-variant/50">#{ticket.id?.substring(0, 6) || 'INC'}</span>
                    </div>
                    <p className="font-body-sm text-body-sm text-on-surface group-hover:text-primary transition-colors truncate">{ticket.title}</p>
                  </div>
                  <span className="material-symbols-outlined text-on-surface-variant/40 group-hover:text-primary transition-transform group-hover:translate-x-0.5">chevron_right</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
