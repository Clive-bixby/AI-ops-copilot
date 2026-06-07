import { useState } from 'react';

interface DocumentItem {
  id: string;
  name: string;
  type: string;
  status: 'Ready' | 'Processing' | 'Failed';
  uploadedBy: string;
  uploadedAt: string;
  icon: string;
}

const mockDocuments: DocumentItem[] = [
  {
    id: 'doc-1',
    name: 'runbook-deploy.pdf',
    type: 'PDF',
    status: 'Ready',
    uploadedBy: 'sysadmin',
    uploadedAt: 'Oct 24, 14:30',
    icon: 'picture_as_pdf',
  },
  {
    id: 'doc-2',
    name: 'postmortem-03.txt',
    type: 'TXT',
    status: 'Processing',
    uploadedBy: 'auto-job-runner',
    uploadedAt: 'Oct 24, 15:10',
    icon: 'description',
  },
  {
    id: 'doc-3',
    name: 'k8s-cluster-config.yaml',
    type: 'YAML',
    status: 'Ready',
    uploadedBy: 'devops-lead',
    uploadedAt: 'Oct 23, 09:15',
    icon: 'code',
  },
  {
    id: 'doc-4',
    name: 'auth-service-logs-Q2.csv',
    type: 'CSV',
    status: 'Failed',
    uploadedBy: 'data-eng',
    uploadedAt: 'Oct 22, 18:45',
    icon: 'table_chart',
  },
];

export function Documents() {
  const [documents] = useState<DocumentItem[]>(mockDocuments);
  const [statusFilter, setStatusFilter] = useState('All');
  const [typeFilter, setTypeFilter] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredDocuments = documents.filter(doc => {
    const matchesStatus = statusFilter === 'All' || doc.status === statusFilter;
    const matchesType = typeFilter === 'All' || doc.type === typeFilter;
    const matchesSearch = doc.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          doc.uploadedBy.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesStatus && matchesType && matchesSearch;
  });

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8 bg-background custom-scrollbar w-full pb-24">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header Section */}
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
          <div>
            <h2 className="font-headline-xl text-[28px] md:text-[36px] text-on-surface font-extrabold tracking-tight leading-none">
              Operational Documents
            </h2>
            <p className="font-body-md text-on-surface-variant/70 mt-2">
              Manage and index your organizational knowledge base for RAG copilot searches.
            </p>
          </div>
          <button className="flex items-center justify-center gap-2 bg-primary hover:bg-primary/95 text-on-primary px-6 py-3 rounded-xl font-body-md text-body-md font-bold transition-all shadow-[0_4px_15px_rgba(192,193,255,0.12)] w-full sm:w-auto">
            <span className="material-symbols-outlined text-[20px]">upload_file</span>
            Upload Document
          </button>
        </div>

        {/* Filters Bar */}
        <div className="bg-surface-container-low border border-outline-variant/15 rounded-2xl p-4 flex flex-col md:flex-row gap-4 items-center justify-between">
          <div className="flex flex-col sm:flex-row gap-3 items-center w-full md:w-auto">
            <div className="relative w-full sm:w-44">
              <select 
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                aria-label="Filter by Status"
                title="Filter by Status"
                className="appearance-none w-full bg-surface border border-outline-variant/20 text-on-surface rounded-xl pl-3 pr-10 py-2 font-body-sm text-body-sm focus:ring-1 focus:ring-primary focus:border-primary outline-none transition-all cursor-pointer"
              >
                <option value="All">Status: All</option>
                <option value="Ready">Ready</option>
                <option value="Processing">Processing</option>
                <option value="Failed">Failed</option>
              </select>
              <span className="material-symbols-outlined absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant/60 pointer-events-none text-[18px]">expand_more</span>
            </div>
            
            <div className="relative w-full sm:w-44">
              <select 
                value={typeFilter}
                onChange={e => setTypeFilter(e.target.value)}
                aria-label="Filter by Type"
                title="Filter by Type"
                className="appearance-none w-full bg-surface border border-outline-variant/20 text-on-surface rounded-xl pl-3 pr-10 py-2 font-body-sm text-body-sm focus:ring-1 focus:ring-primary focus:border-primary outline-none transition-all cursor-pointer"
              >
                <option value="All">Type: All</option>
                <option value="PDF">PDF</option>
                <option value="TXT">TXT</option>
                <option value="YAML">YAML</option>
                <option value="CSV">CSV</option>
              </select>
              <span className="material-symbols-outlined absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant/60 pointer-events-none text-[18px]">expand_more</span>
            </div>
          </div>
          
          <div className="flex gap-4 items-center w-full md:w-auto justify-between md:justify-end">
            <div className="relative w-full sm:w-64">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant/50 text-[18px]">search</span>
              <input 
                className="w-full bg-surface border border-outline-variant/20 rounded-xl py-2 pl-10 pr-4 font-body-sm text-body-sm text-on-surface focus:ring-1 focus:ring-primary focus:border-primary outline-none placeholder:text-on-surface-variant/40" 
                placeholder="Filter files..." 
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
            </div>
            <div className="h-6 w-px bg-outline-variant/20 hidden sm:block"></div>
            <button className="flex items-center gap-1.5 text-on-surface-variant hover:text-primary transition-colors font-body-sm text-body-sm shrink-0">
              <span className="material-symbols-outlined text-[16px]">sort</span>
              Sort
            </button>
          </div>
        </div>

        {/* Document Table */}
        <div className="bg-surface-container-low border border-outline-variant/15 rounded-2xl overflow-hidden shadow-xl">
          <div className="overflow-x-auto w-full custom-scrollbar">
            <table className="w-full text-left border-collapse min-w-[800px]">
              <thead>
                <tr className="border-b border-outline-variant/15 bg-surface-container">
                  <th className="p-4 w-12">
                    <input className="rounded bg-background border-outline-variant/35 text-primary focus:ring-primary cursor-pointer w-4 h-4" type="checkbox" title="Select all documents" aria-label="Select all documents"/>
                  </th>
                  <th className="p-4 font-label-caps text-label-caps text-on-surface-variant/70 tracking-wider uppercase">Document Name</th>
                  <th className="p-4 font-label-caps text-label-caps text-on-surface-variant/70 tracking-wider uppercase w-28">Type</th>
                  <th className="p-4 font-label-caps text-label-caps text-on-surface-variant/70 tracking-wider uppercase w-36">Status</th>
                  <th className="p-4 font-label-caps text-label-caps text-on-surface-variant/70 tracking-wider uppercase hidden lg:table-cell">Uploaded By</th>
                  <th className="p-4 font-label-caps text-label-caps text-on-surface-variant/70 tracking-wider uppercase hidden sm:table-cell w-40">Date Ingested</th>
                  <th className="p-4 w-24"></th>
                </tr>
              </thead>
              <tbody className="font-code-md text-code-md divide-y divide-outline-variant/5">
                {filteredDocuments.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-on-surface-variant/60 font-body-sm">
                      No operational documents matched the selected filters.
                    </td>
                  </tr>
                ) : (
                  filteredDocuments.map(doc => (
                    <tr key={doc.id} className="zebra-row table-row-hover group transition-colors">
                      <td className="p-4">
                        <input className="rounded bg-background border-outline-variant/35 text-primary focus:ring-primary cursor-pointer w-4 h-4" type="checkbox" title={`Select ${doc.name}`} aria-label={`Select ${doc.name}`}/>
                      </td>
                      <td className="p-4 flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                          doc.status === 'Failed' ? 'bg-error/10 text-error' : 'bg-primary/10 text-primary border border-primary/10'
                        }`}>
                          <span className="material-symbols-outlined text-[18px]">{doc.icon}</span>
                        </div>
                        <span className="text-on-surface font-semibold truncate max-w-[200px] md:max-w-xs">{doc.name}</span>
                      </td>
                      <td className="p-4">
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold bg-surface-container border border-outline-variant/20 text-on-surface-variant">
                          {doc.type}
                        </span>
                      </td>
                      <td className="p-4">
                        {doc.status === 'Ready' && (
                          <div className="flex items-center gap-1.5 text-primary">
                            <span className="relative flex h-2 w-2">
                              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary shadow-[0_0_8px_#c0c1ff]"></span>
                            </span>
                            <span className="font-body-sm text-body-sm font-semibold">Indexed</span>
                          </div>
                        )}
                        {doc.status === 'Processing' && (
                          <div className="flex items-center gap-1.5 text-[#facc15]">
                            <span className="material-symbols-outlined text-[14px] animate-spin">sync</span>
                            <span className="font-body-sm text-body-sm font-semibold">Chunking...</span>
                          </div>
                        )}
                        {doc.status === 'Failed' && (
                          <div className="flex items-center gap-1.5 text-error">
                            <span className="material-symbols-outlined text-[14px]">error</span>
                            <span className="font-body-sm text-body-sm font-semibold">Ingest Failed</span>
                          </div>
                        )}
                      </td>
                      <td className="p-4 text-on-surface-variant/80 hidden lg:table-cell font-body-sm">
                        {doc.uploadedBy}
                      </td>
                      <td className="p-4 text-on-surface-variant/60 hidden sm:table-cell font-body-sm font-medium">
                        {doc.uploadedAt}
                      </td>
                      <td className="p-4">
                        <div className="flex items-center justify-end gap-2 md:opacity-0 group-hover:opacity-100 transition-opacity">
                          {doc.status === 'Failed' ? (
                            <button className="text-on-surface-variant hover:text-primary transition-colors p-1.5 hover:bg-surface-variant/50 rounded-lg" title="Retry Ingest">
                              <span className="material-symbols-outlined text-[18px]">refresh</span>
                            </button>
                          ) : (
                            <button className="text-on-surface-variant hover:text-primary transition-colors p-1.5 hover:bg-surface-variant/50 rounded-lg" title="View Contents">
                              <span className="material-symbols-outlined text-[18px]">visibility</span>
                            </button>
                          )}
                          <button className="text-on-surface-variant hover:text-error transition-colors p-1.5 hover:bg-surface-variant/50 rounded-lg" title="Delete Document">
                            <span className="material-symbols-outlined text-[18px]">delete</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          
          {/* Table Footer */}
          <div className="bg-surface-container/60 p-4 flex justify-between items-center font-body-sm text-body-sm text-on-surface-variant border-t border-outline-variant/15">
            <span className="font-medium">Showing {filteredDocuments.length} of {documents.length} operational papers</span>
            <div className="flex gap-2">
              <button className="p-1 rounded hover:bg-surface-variant/50 disabled:opacity-30 disabled:hover:bg-transparent transition-colors" disabled>
                <span className="material-symbols-outlined text-sm">chevron_left</span>
              </button>
              <button className="p-1 rounded hover:bg-surface-variant/50 disabled:opacity-30 disabled:hover:bg-transparent transition-colors" disabled>
                <span className="material-symbols-outlined text-sm">chevron_right</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
