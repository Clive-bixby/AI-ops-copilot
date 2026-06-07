const API_URL = 'http://localhost:5000';

export async function initAuth() {
  let token = localStorage.getItem('jwt');
  let orgId = localStorage.getItem('orgId');

  if (token && orgId) {
    return { token, orgId };
  }

  // Attempt to register a default dev user. If it fails due to conflict, login.
  try {
    const registerRes = await fetch(`${API_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'dev@aiops.local',
        password: 'password123',
        organizationName: 'Dev Organization'
      })
    });

    if (registerRes.ok) {
      const data = await registerRes.json();
      token = data.token;
    } else if (registerRes.status === 409) {
      // Conflict means user exists, so login
      const loginRes = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'dev@aiops.local',
          password: 'password123'
        })
      });
      if (loginRes.ok) {
        const data = await loginRes.json();
        token = data.token;
      } else {
        throw new Error('Login failed');
      }
    } else {
      throw new Error('Registration failed');
    }

    if (!token) throw new Error('No token received');

    // Decode JWT to get organizationId
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
      return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));

    const decoded = JSON.parse(jsonPayload);
    orgId = decoded.organizationId;

    if (token && orgId) {
      localStorage.setItem('jwt', token);
      localStorage.setItem('orgId', orgId);
    }

    return { token, orgId };
  } catch (error) {
    console.error('Failed to initialize auth', error);
    return null;
  }
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
