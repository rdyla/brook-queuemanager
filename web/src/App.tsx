import { useEffect, useMemo, useState } from "react";
import { bulkCreateFromCsv, createQueue, deleteQueue, listQueues, patchQueue } from "./api/client";

type Queue = any;

function prettyJson(x: any) {
  return JSON.stringify(x, null, 2);
}

function safeParseJson(text: string) {
  try {
    return { ok: true as const, value: JSON.parse(text) };
  } catch (e: any) {
    return { ok: false as const, error: e?.message || String(e) };
  }
}

/**
 * Remove a few common read-only/noisy keys to reduce PATCH failures.
 * You can expand this list as you discover what Zoom rejects.
 */
function stripReadOnlyKeys(obj: any) {
  if (!obj || typeof obj !== "object") return obj;
  const deny = new Set([
    "queue_id",
    "id",
    "created_at",
    "updated_at",
    "last_modified_time",
    "total_records",
    "next_page_token",
  ]);
  const out: any = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (deny.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Minimal CSV parser for UI preview (matches worker behavior closely). */
function parseCsvUi(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (c === '"' && next === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      continue;
    }

    if (c === ",") {
      row.push(field.trim());
      field = "";
      continue;
    }

    if (c === "\n") {
      row.push(field.trim());
      field = "";
      if (row.some((x) => x.length > 0)) rows.push(row);
      row = [];
      continue;
    }

    if (c === "\r") continue;
    field += c;
  }

  row.push(field.trim());
  if (row.some((x) => x.length > 0)) rows.push(row);

  if (rows.length < 1) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => (obj[h] = (r[idx] ?? "").trim()));
    return obj;
  });
}

function buildFullCsvTemplate(): string {
  // We don't have a live schema call here, so provide a "maximal" template
  // that covers common queue settings and matches your worker’s mapping.
  // Add/remove columns as you learn Zoom’s full supported fields.
  return [
    [
      "queue_name",
      "queue_description",
      "channel_types",
      "max_wait_time",
      "wrap_up_time",
      "max_engagement_in_queue",
      // placeholders for commonly-needed fields you might support later:
      "timezone",
      "business_hours_id",
      "overflow_queue_id",
      "routing_profile_id",
      "skills",
      "outbound_caller_id",
      "recording_enabled",
      "auto_answer",
      "priority",
      "custom_json",
    ].join(","),
    [
      "Example Voice Queue",
      "Created from CSV",
      "voice",
      "300",
      "30",
      "10",
      "America/Los_Angeles",
      "",
      "",
      "",
      "skillA|skillB",
      "",
      "true",
      "false",
      "1",
      "{\"notes\":\"put any extra fields here\"}",
    ].join(","),
  ].join("\n") + "\n";
}

function Modal({
  title,
  children,
  onClose,
  footer,
  width = 900,
}: {
  title: string;
  children: any;
  onClose: () => void;
  footer?: any;
  width?: number;
}) {
  return (
    <div
      onMouseDown={(e) => {
        // click outside to close
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        zIndex: 9999,
      }}
    >
      <div
        style={{
          width: "min(95vw, " + width + "px)",
          maxHeight: "90vh",
          background: "white",
          borderRadius: 14,
          boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ padding: 14, borderBottom: "1px solid #eee", display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{ fontWeight: 800, fontSize: 16, flex: 1 }}>{title}</div>
          <button onClick={onClose}>Close</button>
        </div>

        <div style={{ padding: 14, overflow: "auto" }}>{children}</div>

        {footer && (
          <div style={{ padding: 14, borderTop: "1px solid #eee", display: "flex", gap: 10, justifyContent: "flex-end" }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
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
    })
  );
  const [createResult, setCreateResult] = useState<string>("");

  // Edit modal
  const [editing, setEditing] = useState<Queue | null>(null);
  const [patchPayload, setPatchPayload] = useState<string>("");
  const [patchResult, setPatchResult] = useState<string>("");
  const [sendDiffOnly, setSendDiffOnly] = useState<boolean>(true);

  // Delete confirm
  const [deleteConfirmText, setDeleteConfirmText] = useState<string>("");

  // Bulk CSV
  const [csvText, setCsvText] = useState<string>("queue_name,queue_description,channel_types\nExample Queue,Created from CSV,voice\n");
  const [bulkResult, setBulkResult] = useState<string>("");

  // Bulk preview modal
  const [bulkPreviewOpen, setBulkPreviewOpen] = useState(false);
  const [bulkParsed, setBulkParsed] = useState<Record<string, string>[]>([]);
  const [bulkConfirmBusy, setBulkConfirmBusy] = useState(false);

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
    setDeleteConfirmText("");
    // Populate with FULL object for quick searching/editing.
    setPatchPayload(prettyJson(q));
  }

  async function submitCreate() {
    setCreateResult("");
    setErr(null);
    const parsed = safeParseJson(createPayload);
    if (!parsed.ok) return setErr(parsed.error);

    try {
      const res = await createQueue(parsed.value);
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

    const parsed = safeParseJson(patchPayload);
    if (!parsed.ok) return setErr(parsed.error);

    try {
      const id = String(editing.queue_id || editing.id);
      let payloadToSend = parsed.value;

      if (sendDiffOnly) {
        // Strip read-only keys to avoid common 400s
        payloadToSend = stripReadOnlyKeys(payloadToSend);
      }

      const res = await patchQueue(id, payloadToSend);
      setPatchResult(prettyJson(res));
      if (res?.ok) {
        setEditing(null);
        await refresh();
      }
    } catch (e: any) {
      setErr(e?.message || String(e));
    }
  }

  async function submitDelete() {
    if (!editing) return;
    setErr(null);
    setPatchResult("");

    if (deleteConfirmText.trim().toUpperCase() !== "DELETE") {
      return setErr('To delete, type DELETE in the confirmation box.');
    }

    try {
      const id = String(editing.queue_id || editing.id);
      const res = await deleteQueue(id);
      setPatchResult(prettyJson(res));
      if (res?.ok) {
        setEditing(null);
        await refresh();
      }
    } catch (e: any) {
      setErr(e?.message || String(e));
    }
  }

  function openBulkPreview() {
    setErr(null);
    try {
      const rows = parseCsvUi(csvText);
      setBulkParsed(rows);
      setBulkPreviewOpen(true);
    } catch (e: any) {
      setErr(e?.message || String(e));
    }
  }

  async function confirmBulkCreate() {
    setBulkConfirmBusy(true);
    setBulkResult("");
    setErr(null);
    try {
      const res = await bulkCreateFromCsv(csvText);
      setBulkResult(prettyJson(res));
      if (res?.ok) {
        setBulkPreviewOpen(false);
        setActiveTab("list");
        await refresh();
      }
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBulkConfirmBusy(false);
    }
  }

  return (
    <div style={{ fontFamily: "system-ui", padding: 20, maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ margin: 0 }}>Brook Queue Manager</h1>

      <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={refresh} disabled={loading}>Refresh</button>

        <button onClick={() => setActiveTab("list")} disabled={activeTab === "list"}>Queues</button>
        <button onClick={() => setActiveTab("create")} disabled={activeTab === "create"}>Create</button>
        <button onClick={() => setActiveTab("bulk")} disabled={activeTab === "bulk"}>Bulk CSV</button>

        {loading && <span>Loading…</span>}
        {err && <span style={{ color: "crimson" }}>{err}</span>}
      </div>

      {activeTab === "list" && (
        <div style={{ marginTop: 14 }}>
          <div style={{ opacity: 0.8, marginBottom: 8 }}>{sorted.length} queues</div>

          <table cellPadding={8} style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                <th style={{ width: 320 }}>Name</th>
                <th style={{ width: 280 }}>ID</th>
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
                  <td colSpan={4} style={{ opacity: 0.7 }}>No queues returned.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === "create" && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 800, marginBottom: 8 }}>Create Queue</div>
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
          <div style={{ fontWeight: 800, marginBottom: 8 }}>Bulk Create from CSV</div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <button
              onClick={() => setCsvText(buildFullCsvTemplate())}
              title="Insert a full template with many optional columns"
            >
              Insert full CSV template
            </button>
            <button onClick={openBulkPreview}>Preview &amp; Confirm</button>
          </div>

          <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>
            CSV supports whatever your Worker maps. For channel_types use “voice|chat”.
          </div>

          <textarea
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            spellCheck={false}
            style={{ width: "100%", minHeight: 240, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
          />

          {bulkResult && (
            <pre style={{ marginTop: 10, background: "#f7f7f7", padding: 10, borderRadius: 10, overflow: "auto" }}>
              {bulkResult}
            </pre>
          )}
        </div>
      )}

      {/* Edit Modal */}
      {editing && (
        <Modal
          title={`Edit Queue: ${editing.queue_name || editing.name || ""}`}
          onClose={() => setEditing(null)}
          footer={
            <>
              <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-start" }}>
                <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={sendDiffOnly}
                    onChange={(e) => setSendDiffOnly(e.target.checked)}
                  />
                  Strip read-only keys before PATCH
                </label>
              </div>

              <button onClick={submitPatch} style={{ fontWeight: 700 }}>
                Save (PATCH)
              </button>

              <button
                onClick={submitDelete}
                style={{
                  background: "#b00020",
                  color: "white",
                  border: "none",
                  padding: "8px 12px",
                  borderRadius: 8,
                }}
                title="Deletes the queue (danger)"
              >
                Delete
              </button>
            </>
          }
        >
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
            <div style={{ fontFamily: "monospace", opacity: 0.75 }}>
              {String(editing.queue_id || editing.id)}
            </div>

            <div style={{ fontSize: 12, opacity: 0.75 }}>
              Payload is prefilled with the full queue object from GET so you can search fields quickly.
              If PATCH rejects fields, keep “Strip read-only keys” enabled.
            </div>

            <textarea
              value={patchPayload}
              onChange={(e) => setPatchPayload(e.target.value)}
              spellCheck={false}
              style={{ width: "100%", minHeight: 320, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
            />

            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                To delete, type <b>DELETE</b>:
              </div>
              <input
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder="DELETE"
                style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #ddd" }}
              />
              <button onClick={() => setPatchPayload("{}")}>Clear editor</button>
            </div>

            {patchResult && (
              <pre style={{ marginTop: 0, background: "#f7f7f7", padding: 10, borderRadius: 10, overflow: "auto" }}>
                {patchResult}
              </pre>
            )}
          </div>
        </Modal>
      )}

      {/* Bulk Preview Modal */}
      {bulkPreviewOpen && (
        <Modal
          title="Bulk Create Preview"
          onClose={() => setBulkPreviewOpen(false)}
          width={1000}
          footer={
            <>
              <button onClick={() => setBulkPreviewOpen(false)}>Cancel</button>
              <button
                onClick={confirmBulkCreate}
                disabled={bulkConfirmBusy}
                style={{
                  background: "#0a7a2f",
                  color: "white",
                  border: "none",
                  padding: "8px 12px",
                  borderRadius: 8,
                  fontWeight: 800,
                }}
              >
                {bulkConfirmBusy ? "Creating…" : "Confirm & Create"}
              </button>
            </>
          }
        >
          <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 10 }}>
            Below is what we parsed from your CSV. Confirm to create queues.
          </div>

          {!bulkParsed.length ? (
            <div style={{ opacity: 0.8 }}>No rows found.</div>
          ) : (
            <table cellPadding={8} style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                  <th style={{ width: 70 }}>Row</th>
                  <th>queue_name</th>
                  <th>channel_types</th>
                  <th>queue_description</th>
                </tr>
              </thead>
              <tbody>
                {bulkParsed.slice(0, 200).map((r, idx) => (
                  <tr key={idx} style={{ borderBottom: "1px solid #f0f0f0" }}>
                    <td style={{ fontFamily: "monospace" }}>{idx + 1}</td>
                    <td>{r.queue_name || r.name || <span style={{ color: "crimson" }}>(missing)</span>}</td>
                    <td style={{ fontFamily: "monospace" }}>{r.channel_types || "voice"}</td>
                    <td>{r.queue_description || r.description || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {bulkParsed.length > 200 && (
            <div style={{ marginTop: 10, opacity: 0.75 }}>
              Showing first 200 rows of {bulkParsed.length}.
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
