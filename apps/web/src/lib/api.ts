export const API_URL = 'http://localhost:5000';

export async function initAuth() {
  const token = localStorage.getItem('jwt');
  const orgId = localStorage.getItem('orgId');

  if (token && orgId) {
    return { token, orgId };
  }

  return null;
}

export async function apiCall(endpoint: string, options: RequestInit = {}) {
  const token = localStorage.getItem('jwt');
  const orgId = localStorage.getItem('orgId');

  const headers = new Headers(options.headers || {});
  
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (orgId) {
    headers.set('x-organization-id', orgId);
  }

  // Set default content type to json if not FormData
  if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    throw new Error(`API Error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}
