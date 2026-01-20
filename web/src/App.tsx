import { useEffect, useState } from "react";
import { listQueues } from "./api/client";

export default function App() {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [queues, setQueues] = useState<any[]>([]);

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const res = await listQueues({ channel: "voice", page_size: "50" });
      if (!res?.ok) throw new Error(res?.data?.message || "API error");
      const items = res?.data?.queues || res?.data?.data?.queues || res?.data?.queues || [];
      setQueues(items);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div style={{ fontFamily: "system-ui", padding: 24 }}>
      <h1 style={{ marginTop: 0 }}>Brook Queue Manager</h1>

      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button onClick={refresh} disabled={loading}>
          Refresh
        </button>
        {loading && <span>Loading…</span>}
        {err && <span style={{ color: "crimson" }}>{err}</span>}
      </div>

      <div style={{ marginTop: 16 }}>
        <table cellPadding={8} style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
              <th>Name</th>
              <th>ID</th>
              <th>Channels</th>
            </tr>
          </thead>
          <tbody>
            {queues.map((q) => (
              <tr key={q.queue_id || q.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
                <td>{q.queue_name || q.name}</td>
                <td style={{ fontFamily: "monospace" }}>{q.queue_id || q.id}</td>
                <td>{Array.isArray(q.channel_types) ? q.channel_types.join(", ") : ""}</td>
              </tr>
            ))}
            {!queues.length && !loading && (
              <tr>
                <td colSpan={3} style={{ opacity: 0.7 }}>
                  No queues returned.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
