import { useEffect, useState } from 'react';
import { apiCall } from '../lib/api';

interface Log {
  id: string;
  timestamp: string;
  level: string;
  message: string;
}

export function Logs() {
  const [logs, setLogs] = useState<Log[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedLevel, setSelectedLevel] = useState('ALL');

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const data = await apiCall('/logs');
        setLogs(data as Log[]);
      } catch (error) {
        console.error("Failed to load logs", error);
      } finally {
        setLoading(false);
      }
    };
    fetchLogs();
  }, []);

  const getLevelStyles = (level: string) => {
    const l = (level || '').toLowerCase();
    if (l === 'info') return 'bg-primary/10 text-primary border-primary/20';
    if (l === 'error') return 'bg-error/15 text-error border-error/25 animate-pulse';
    if (l === 'warn' || l === 'warning') return 'bg-orange-400/10 text-orange-400 border-orange-400/20';
    if (l === 'debug') return 'bg-on-surface-variant/10 text-on-surface-variant/80 border-outline-variant/30';
    return 'bg-surface-variant text-on-surface-variant border-outline-variant/20';
  };

  const filteredLogs = logs.filter(log => {
    const matchesLevel = selectedLevel === 'ALL' || log.level?.toUpperCase() === selectedLevel;
    const matchesSearch = log.message?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          log.level?.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesLevel && matchesSearch;
  });

  return (
    <div className="flex-1 flex flex-col h-full bg-background overflow-hidden relative pb-16">
      {/* Filter Bar Area */}
      <section className="bg-surface-container py-5 px-4 md:px-8 border-b border-outline-variant/15 shrink-0 w-full">
        <div className="flex flex-col gap-4 max-w-7xl mx-auto">
          {/* Search Input */}
          <div className="relative w-full">
            <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-on-surface-variant/50 text-[20px]">search</span>
            <input 
              className="w-full bg-surface border border-outline-variant/20 rounded-xl py-2.5 pl-11 pr-4 text-on-surface font-body-sm text-body-sm focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 placeholder-on-surface-variant/40 transition-colors" 
              placeholder="Filter logs by message, keyword, or level..." 
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              aria-label="Filter logs"
            />
          </div>

          {/* Filters Row */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center bg-background border border-outline-variant/15 rounded-xl p-1">
              {['ALL', 'INFO', 'WARN', 'ERROR'].map(lvl => (
                <button 
                  key={lvl}
                  onClick={() => setSelectedLevel(lvl)}
                  className={`px-4 py-1.5 rounded-lg font-label-caps text-[11px] font-bold tracking-wider uppercase transition-all ${
                    selectedLevel === lvl 
                      ? 'bg-surface-variant text-on-surface shadow-md' 
                      : 'text-on-surface-variant/60 hover:text-on-surface hover:bg-surface-variant/20'
                  }`}
                >
                  {lvl}
                </button>
              ))}
            </div>
            
            <div className="text-on-surface-variant/40 font-code-sm text-[11px] font-medium">
              Showing {filteredLogs.length} of {logs.length} indexed event packets
            </div>
          </div>
        </div>
      </section>

      {/* Log Stream Container */}
      <section className="flex-1 overflow-y-auto log-scroll bg-background/50 relative flex flex-col w-full h-full pb-20">
        <div className="max-w-7xl mx-auto w-full px-4 md:px-8 py-4">
          <div className="bg-[#0c0c0d] border border-outline-variant/15 rounded-2xl overflow-hidden shadow-2xl">
            <table className="w-full text-left border-collapse table-fixed">
              <thead className="bg-surface-container/60 border-b border-outline-variant/10">
                <tr>
                  <th className="py-3 px-4 font-label-caps text-label-caps text-on-surface-variant/70 uppercase tracking-wider w-[120px] md:w-[150px]">Timestamp</th>
                  <th className="py-3 px-4 font-label-caps text-label-caps text-on-surface-variant/70 uppercase tracking-wider w-[90px] md:w-[110px]">Level</th>
                  <th className="py-3 px-4 font-label-caps text-label-caps text-on-surface-variant/70 uppercase tracking-wider">Message payload</th>
                </tr>
              </thead>
              <tbody className="font-code-sm text-code-sm text-on-surface-variant/80 divide-y divide-outline-variant/5">
                {loading ? (
                  <tr>
                    <td colSpan={3} className="py-12 text-center text-on-surface-variant/60 font-body-sm">
                      <div className="flex items-center justify-center gap-2">
                        <span className="material-symbols-outlined text-[18px] animate-spin">sync</span>
                        Streaming logs telemetry...
                      </div>
                    </td>
                  </tr>
                ) : filteredLogs.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="py-12 text-center text-on-surface-variant/50 font-body-sm">
                      No operational logs found matching query filters.
                    </td>
                  </tr>
                ) : (
                  filteredLogs.map((log, index) => (
                    <tr 
                      key={log.id || index} 
                      className={`hover:bg-surface-container/30 transition-colors group ${
                        log.level?.toLowerCase() === 'error' 
                          ? 'bg-error-container/5 border-l-2 border-l-error' 
                          : index % 2 === 0 ? 'bg-background/20' : ''
                      }`}
                    >
                      <td className={`py-3 px-4 whitespace-nowrap text-on-surface-variant/50 align-top font-medium ${
                        log.level?.toLowerCase() === 'error' ? 'text-error' : ''
                      }`}>
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </td>
                      <td className="py-3 px-4 align-top">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-extrabold tracking-widest uppercase border ${getLevelStyles(log.level)}`}>
                          {log.level || 'INFO'}
                        </span>
                      </td>
                      <td className="py-3 px-4 align-top break-all select-text">
                        <div className={`font-code-md text-code-md leading-relaxed ${
                          log.level?.toLowerCase() === 'error' 
                            ? 'text-error font-semibold' 
                            : 'text-on-surface/90 group-hover:text-primary transition-colors'
                        }`}>
                          {log.message}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
