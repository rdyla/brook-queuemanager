const API_BASE = ""; // same origin; if split origins, set to your worker URL

function headers() {
  return {
    "content-type": "application/json",
    // optional pre-Access lock:
    // "x-admin-api-key": import.meta.env.VITE_ADMIN_API_KEY,
  };
}

export async function listQueues(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API_BASE}/api/queues?${qs}`, { method: "GET" });
  return await res.json();
}

// ✅ ADD THIS
export async function getQueue(queueId: string) {
  const res = await fetch(`${API_BASE}/api/queues/${encodeURIComponent(queueId)}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  return await res.json();
}

export async function createQueue(payload: any) {
  const res = await fetch(`${API_BASE}/api/queues`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload),
  });
  return await res.json();
}

export async function patchQueue(queueId: string, patch: any) {
  const res = await fetch(`${API_BASE}/api/queues/${encodeURIComponent(queueId)}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify(patch),
  });
  return await res.json();
}

export async function bulkCreateFromCsv(csv: string) {
  const res = await fetch(`${API_BASE}/api/queues/bulk`, {
    method: "POST",
    headers: { "content-type": "text/csv" },
    body: csv,
  });
  return await res.json();
}
