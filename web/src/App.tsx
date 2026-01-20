import { useEffect, useMemo, useState } from "react";
import { bulkCreateFromCsv, createQueue, listQueues, patchQueue } from "./api/client";

type Queue = any;

function prettyJson(x: any) {
  return JSON.stringify(x, null, 2);
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [queues, setQueues] = useState<Queue[]>([]);
  const [activeTab, setActiveTab] = useState<"list" | "create" | "bulk">("list");

  // Create form
  const [createPayload, setCreatePayload] = useState(() =>
    prettyJson({
      queue_name: "",
      queue_description: "",
      channel_types: ["voice"],
      // add more fields as needed
    })
  );
  const [createResult, setCreateResult] = useState<string>("");

  // Edit form
  const [editing, setEditing] = useState<Queue | null>(null);
  const [patchPayload, setPatchPayload] = useState<string>("");
  const [patchResult, setPatchResult] = useState<string>("");

  // Bulk
  const [csvText, setCsvText] = useState<string>(
    "queue_name,queue_description,channel_types\nExample Queue,Created from CSV,voice\n"
  );
  const [bulkResult, setBulkResult] = useState<string>("");

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const res = await listQueues({ channel: "voice", page_size: "100" });
      if (!res?.ok) throw new Error(res?.message || res?.data?.message || "API error");
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

  const sorted = useMemo(() => {
    return [...queues].sort((a, b) =>
      String(a.queue_name || a.name || "").localeCompare(String(b.queue_name || b.name || ""))
    );
  }, [queues]);

  function openEdit(q: Queue) {
    setEditing(q);
    setPatchResult("");
    // start with a minimal, safe patch payload
    setPatchPayload(
      prettyJson({
        queue_name: q.queue_name || "",
        queue_description: q.queue_description || "",
        // channel_types is often editable; keep if present
        ...(Array.isArray(q.channel_types) ? { channel_types: q.channel_types } : {}),
      })
    );
  }

  async function submitCreate() {
    setCreateResult("");
    setErr(null);
    try {
      const payload = JSON.parse(createPayload);
      const res = await createQueue(payload);
      setCreateResult(prettyJson(res));
      if (res?.ok) {
        setActiveTab("list");
        await refresh();
      }
    } catch (e: any) {
      setErr(e?.message || String(e));
    }
  }

  async function submitPatch() {
    if (!editing) return;
    setPatchResult("");
    setErr(null);
    try {
      const payload = JSON.parse(patchPayload);
      const id = editing.queue_id || editing.id;
      const res = await patchQueue(String(id), payload);
      setPatchResult(prettyJson(res));
      if (res?.ok) {
        setEditing(null);
        await refresh();
      }
    } catch (e: any) {
      setErr(e?.message || String(e));
    }
  }

  async function submitBulk() {
    setBulkResult("");
    setErr(null);
    try {
      const res = await bulkCreateFromCsv(csvText);
      setBulkResult(prettyJson(res));
      if (res?.ok) {
        setActiveTab("list");
        await refresh();
      }
    } catch (e: any) {
      setErr(e?.message || String(e));
    }
  }

  return (
    <div style={{ fontFamily: "system-ui", padding: 20, maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ margin: 0 }}>Brook Queue Manager</h1>

      <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={refresh} disabled={loading}>Refresh</button>

        <button onClick={() => setActiveTab("list")} disabled={activeTab === "list"}>
          Queues
        </button>
        <button onClick={() => setActiveTab("create")} disabled={activeTab === "create"}>
          Create
        </button>
        <button onClick={() => setActiveTab("bulk")} disabled={activeTab === "bulk"}>
          Bulk CSV
        </button>

        {loading && <span>Loading…</span>}
        {err && <span style={{ color: "crimson" }}>{err}</span>}
      </div>

      {activeTab === "list" && (
        <div style={{ marginTop: 14 }}>
          <div style={{ opacity: 0.8, marginBottom: 8 }}>
            {sorted.length} queues
          </div>

          <table cellPadding={8} style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                <th style={{ width: 280 }}>Name</th>
                <th style={{ width: 260 }}>ID</th>
                <th style={{ width: 160 }}>Channels</th>
                <th style={{ width: 120 }} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((q) => (
                <tr key={q.queue_id || q.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
                  <td>{q.queue_name || q.name}</td>
                  <td style={{ fontFamily: "monospace" }}>{q.queue_id || q.id}</td>
                  <td>{Array.isArray(q.channel_types) ? q.channel_types.join(", ") : ""}</td>
                  <td style={{ textAlign: "right" }}>
                    <button onClick={() => openEdit(q)}>Edit</button>
                  </td>
                </tr>
              ))}
              {!sorted.length && !loading && (
                <tr>
                  <td colSpan={4} style={{ opacity: 0.7 }}>
                    No queues returned.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {editing && (
            <div style={{ marginTop: 16, padding: 12, border: "1px solid #ddd", borderRadius: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 700 }}>Edit Queue</div>
                  <div style={{ fontFamily: "monospace", opacity: 0.7 }}>
                    {editing.queue_id || editing.id}
                  </div>
                </div>
                <button onClick={() => setEditing(null)}>Close</button>
              </div>

              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>
                  PATCH payload (JSON). Only include fields you intend to change.
                </div>
                <textarea
                  value={patchPayload}
                  onChange={(e) => setPatchPayload(e.target.value)}
                  spellCheck={false}
                  style={{ width: "100%", minHeight: 180, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                />
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button onClick={submitPatch}>Save (PATCH)</button>
                  <button onClick={() => setPatchPayload("{}")}>Clear</button>
                </div>

                {patchResult && (
                  <pre style={{ marginTop: 10, background: "#f7f7f7", padding: 10, borderRadius: 10, overflow: "auto" }}>
                    {patchResult}
                  </pre>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === "create" && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Create Queue</div>
          <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>
            POST payload (JSON). Zoom will validate required fields.
          </div>
          <textarea
            value={createPayload}
            onChange={(e) => setCreatePayload(e.target.value)}
            spellCheck={false}
            style={{ width: "100%", minHeight: 220, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button onClick={submitCreate}>Create</button>
          </div>

          {createResult && (
            <pre style={{ marginTop: 10, background: "#f7f7f7", padding: 10, borderRadius: 10, overflow: "auto" }}>
              {createResult}
            </pre>
          )}
        </div>
      )}

      {activeTab === "bulk" && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Bulk Create from CSV</div>
          <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>
            CSV headers supported: queue_name, queue_description, channel_types (use “voice|chat” format)
          </div>
          <textarea
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            spellCheck={false}
            style={{ width: "100%", minHeight: 220, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button onClick={submitBulk}>Bulk Create</button>
          </div>

          {bulkResult && (
            <pre style={{ marginTop: 10, background: "#f7f7f7", padding: 10, borderRadius: 10, overflow: "auto" }}>
              {bulkResult}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
