import { useState, useRef, useEffect } from 'react';
import { apiCall } from '../lib/api';

interface Source {
  filename?: string;
  score?: number;
}

interface Message {
  id: string;
  role: 'user' | 'ai';
  content: string;
  sources?: Source[];
}

export function Copilot() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: input };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    try {
      const response = await apiCall('/ai/ask', {
        method: 'POST',
        body: JSON.stringify({ question: userMsg.content }),
      });

      const aiMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'ai',
        content: response.answer,
        sources: response.sources as Source[],
      };

      setMessages(prev => [...prev, aiMsg]);
    } catch (error: unknown) {
      const errorMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'ai',
        content: `Error: ${error instanceof Error ? error.message : 'Something went wrong.'}`,
      };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex-1 flex overflow-hidden bg-background">
      {/* Chat History Sidebar */}
      <div className="w-64 border-r border-outline-variant/20 bg-surface-container-low/30 flex flex-col hidden lg:flex">
        <div className="p-md py-4 flex items-center justify-between border-b border-outline-variant/10">
          <span className="font-label-caps text-label-caps text-on-surface-variant font-bold tracking-wider uppercase">Operational Sessions</span>
          <button className="p-1.5 rounded-lg hover:bg-surface-variant/50 text-on-surface-variant/80 hover:text-on-surface transition-colors">
            <span className="material-symbols-outlined text-[18px]">edit_square</span>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 custom-scrollbar space-y-2">
          <div className="p-3 rounded-xl bg-surface-container border border-outline-variant/15 text-on-surface cursor-pointer text-sm font-medium hover:border-outline-variant/30 transition-all flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-[16px]" data-weight="fill">chat_bubble</span>
            <span className="truncate">Default Dev Session</span>
          </div>
          <div className="text-on-surface-variant/40 font-body-sm text-[12px] text-center mt-6">No previous sessions found.</div>
        </div>
      </div>

      {/* Chat Interaction Area */}
      <div className="flex-1 flex flex-col relative w-full h-full justify-between">
        {/* Chat Log */}
        <div className="flex-1 overflow-y-auto p-4 md:p-8 custom-scrollbar flex flex-col gap-6 pb-40 w-full max-w-4xl mx-auto">
          
          {messages.length === 0 && (
            <div className="flex-1 flex flex-col items-center justify-center text-center max-w-lg mx-auto py-16">
              <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary mb-6 ai-glow animate-pulse">
                <span className="material-symbols-outlined text-[36px]" data-weight="fill">psychology</span>
              </div>
              <h3 className="text-xl font-bold text-on-surface tracking-tight mb-2">AI Copilot Operational Console</h3>
              <p className="font-body-md text-on-surface-variant/70 text-sm">
                Ask the cognitive agent to analyze logs, search incident playbooks, fetch Kubernetes runbooks, or troubleshoot deployment telemetry.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full mt-8">
                <button 
                  onClick={() => setInput("What are the most recent error logs?")}
                  className="p-3 text-left rounded-xl bg-surface-container/60 hover:bg-surface-container border border-outline-variant/10 text-on-surface-variant hover:text-on-surface text-xs transition-all font-medium"
                >
                  "What are the most recent error logs?"
                </button>
                <button 
                  onClick={() => setInput("Do we have a runbook for database deployment?")}
                  className="p-3 text-left rounded-xl bg-surface-container/60 hover:bg-surface-container border border-outline-variant/10 text-on-surface-variant hover:text-on-surface text-xs transition-all font-medium"
                >
                  "Do we have a database runbook?"
                </button>
              </div>
            </div>
          )}

          {messages.map(msg => (
            <div key={msg.id} className={`flex gap-4 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {msg.role === 'ai' && (
                <div className="w-9 h-9 rounded-xl bg-primary/10 border border-primary/25 text-primary flex items-center justify-center shrink-0 ai-glow">
                  <span className="material-symbols-outlined text-[20px]" data-weight="fill">psychology</span>
                </div>
              )}
              
              <div className={`flex flex-col max-w-[85%] ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                <div className={`p-4 rounded-2xl border ${
                  msg.role === 'user' 
                    ? 'bg-surface-container border-outline-variant/20 text-on-surface rounded-tr-sm' 
                    : 'bg-surface-container-low border-outline-variant/15 text-on-surface rounded-tl-sm ai-border-gradient shadow-lg'
                }`}>
                  <p className="font-body-sm text-body-sm whitespace-pre-wrap leading-relaxed tracking-wide select-text">{msg.content}</p>
                </div>
                
                {msg.role === 'ai' && msg.sources && msg.sources.length > 0 && (
                  <div className="mt-3 w-full">
                    <span className="font-label-caps text-[10px] text-on-surface-variant/50 uppercase tracking-widest block mb-2 font-bold">RAG Reference Sources</span>
                    <div className="flex flex-wrap gap-2">
                      {msg.sources.map((src, i) => (
                        <div key={i} className="bg-surface-container/40 border border-outline-variant/10 rounded-lg p-2 flex items-center gap-2 hover:bg-surface-container transition-all cursor-pointer">
                          <span className="material-symbols-outlined text-primary text-[16px]">find_in_page</span>
                          <span className="font-code-sm text-[11px] text-on-surface/80 truncate max-w-[150px]">{src.filename || 'Document'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {msg.role === 'user' && (
                <div className="w-9 h-9 rounded-xl bg-surface-variant border border-outline-variant/20 flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-[18px] text-on-surface-variant">person</span>
                </div>
              )}
            </div>
          ))}

          {isLoading && (
            <div className="flex gap-4 justify-start">
              <div className="w-9 h-9 rounded-xl bg-primary/10 border border-primary/25 text-primary flex items-center justify-center shrink-0 ai-glow">
                <span className="material-symbols-outlined text-[20px] animate-spin">sync</span>
              </div>
              <div className="flex-1 max-w-[85%]">
                <div className="bg-surface-container-low p-4 rounded-2xl rounded-tl-sm border border-outline-variant/10 font-body-sm text-body-sm text-on-surface-variant/75 animate-pulse flex items-center gap-2">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary/40 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
                  </span>
                  Synthesizing root cause diagnosis...
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Chat Input Area */}
        <div className="absolute bottom-0 left-0 w-full p-4 md:p-6 bg-gradient-to-t from-background via-background/95 to-transparent pt-12 flex justify-center">
          <div className="w-full max-w-4xl">
            <div className="relative bg-surface-container border border-outline-variant/15 rounded-2xl focus-within:border-primary/40 focus-within:ring-1 focus-within:ring-primary/20 transition-all shadow-xl hover:border-outline-variant/30">
              <textarea 
                className="w-full bg-transparent border-none focus:ring-0 text-on-surface font-body-sm text-body-sm resize-none p-4 pb-14 custom-scrollbar placeholder-on-surface-variant/45 outline-none" 
                placeholder="Ask Copilot to query logs, analyze metrics, or suggest fixes..." 
                rows={3}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
              ></textarea>
              <div className="absolute bottom-3 right-3 flex items-center gap-2">
                <span className="font-code-sm text-[11px] text-on-surface-variant/40 hidden sm:inline mr-2">Press Enter to send</span>
                <button 
                  onClick={handleSend}
                  disabled={isLoading || !input.trim()}
                  className="bg-primary text-on-primary px-4 py-2 rounded-xl font-body-sm text-body-sm font-bold flex items-center gap-2 hover:bg-primary/95 disabled:opacity-50 disabled:hover:bg-primary transition-all shadow-lg"
                >
                  <span className="material-symbols-outlined text-[16px]">auto_awesome</span> Send
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
