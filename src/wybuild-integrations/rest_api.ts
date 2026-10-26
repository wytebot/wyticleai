/** WyBuild REST helper. Configure a public base URL at runtime; never put private API keys in browser code. */
export async function wybuildRequest(path: string, options: RequestInit = {}) {
  const base = String((import.meta as any).env?.VITE_API_BASE_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('Set VITE_API_BASE_URL to your API base URL.');
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
  try { const response = await fetch(base + '/' + String(path).replace(/^\//, ''), { ...options, signal: controller.signal, headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } }); const text = await response.text(); let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; } if (!response.ok) throw new Error('API request failed (' + response.status + '): ' + (data?.message || response.statusText)); return data; } finally { clearTimeout(timer); }
}
