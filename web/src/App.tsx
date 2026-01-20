import { useEffect, useMemo, useState } from "react";
import {
  bulkCreateFromCsv,
  createQueue,
  deleteQueue,
  getQueue,
  listQueues,
  patchQueue,
  listQueueTemplates,
  batchCreateQueues,
} from "./api/client";


type Queue = any;
type QueueTemplate = any;

function pickTemplatesFromResponse(res: any): QueueTemplate[] {
  // tolerate shapes
  const data = res?.data?.queue_templates || res?.data?.data?.queue_templates || res?.queue_templates || [];
  return Array.isArray(data) ? data : [];
}


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

/** ---------- Diff helpers (git-style) ---------- */
type DiffLine = { kind: "add" | "remove" | "ctx"; text: string };

function isObj(x: any) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function fmt(v: any) {
  if (typeof v === "string") return JSON.stringify(v);
  return JSON.stringify(v);
}

function collectDiffLines(a: any, b: any, path = ""): DiffLine[] {
  if (a === b) return [];

  if (Array.isArray(a) || Array.isArray(b)) {
    const as = JSON.stringify(a);
    const bs = JSON.stringify(b);
    if (as === bs) return [];
    return [
      { kind: "remove", text: `- ${path || "<root>"}: ${as}` },
      { kind: "add", text: `+ ${path || "<root>"}: ${bs}` },
    ];
  }

  const aIsObj = isObj(a);
  const bIsObj = isObj(b);
  if (!aIsObj || !bIsObj) {
    return [
      { kind: "remove", text: `- ${path || "<root>"}: ${fmt(a)}` },
      { kind: "add", text: `+ ${path || "<root>"}: ${fmt(b)}` },
    ];
  }

  const out: DiffLine[] = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const sorted = [...keys].sort();

  for (const k of sorted) {
    const nextPath = path ? `${path}.${k}` : k;

    if (!(k in b)) {
      out.push({ kind: "remove", text: `- ${nextPath}: ${fmt(a[k])}` });
      continue;
    }
    if (!(k in a)) {
      out.push({ kind: "add", text: `+ ${nextPath}: ${fmt(b[k])}` });
      continue;
    }

    out.push(...collectDiffLines(a[k], b[k], nextPath));
  }

  return out;
}

function DiffBlock({ lines }: { lines: DiffLine[] }) {
  return (
    <pre
      style={{
        margin: 0,
        background: "#f6f8fa",
        padding: 12,
        borderRadius: 12,
        overflow: "auto",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
        lineHeight: 1.5,
        border: "1px solid #e5e7eb",
      }}
    >
      {lines.length ? (
        lines.map((l, i) => {
          const style =
            l.kind === "add"
              ? { color: "#0a7a2f" }
              : l.kind === "remove"
              ? { color: "#b00020" }
              : { opacity: 0.75 };
          return (
            <div key={i} style={style}>
              {l.text}
            </div>
          );
        })
      ) : (
        <div style={{ opacity: 0.75 }}>(no changes)</div>
      )}
    </pre>
  );
}

/** ---------- PATCH diff builder ---------- */
// Deep diff: returns only changed keys, recursively.
// Arrays: if changed, replaces whole array (safe for PATCH).
function deepDiff(original: any, edited: any): any {
  if (original === edited) return undefined;

  const oType = typeof original;
  const eType = typeof edited;

  if (
    original == null ||
    edited == null ||
    oType !== "object" ||
    eType !== "object" ||
    Array.isArray(original) ||
    Array.isArray(edited)
  ) {
    if (Array.isArray(original) && Array.isArray(edited)) {
      if (JSON.stringify(original) === JSON.stringify(edited)) return undefined;
      return edited;
    }
    return edited;
  }

  const out: any = {};
  const keys = new Set([...Object.keys(original), ...Object.keys(edited)]);
  for (const k of keys) {
    if (!(k in edited)) continue; // safer: no deletions by default
    const d = deepDiff(original[k], edited[k]);
    if (d !== undefined) out[k] = d;
  }
  return Object.keys(out).length ? out : undefined;
}

// Common read-only keys: strip from BOTH sides before diffing so they never appear in patch.
function stripReadOnly(obj: any): any {
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

  if (Array.isArray(obj)) return obj.map(stripReadOnly);

  const out: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (deny.has(k)) continue;
    out[k] = stripReadOnly(v);
  }
  return out;
}


/** ---------- CSV helpers (client-side preview) ---------- */
function parseCsv(text: string): Record<string, string>[] {
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

function toNumberOrUndef(s: string) {
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function csvRowToCreatePayload(r: Record<string, string>) {
  return {
    queue_name: r.queue_name || r.name || "",
    queue_description: r.queue_description || r.description || "",
  };
}

/** ---------- Simple Modal ---------- */
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

/** ---------- Templates ---------- */
function createQueueTemplate() {
  return {
    queue_name: "",
    queue_description: "",
    channel_types: ["voice"],

    // Common knobs (may vary by tenant / API evolution):
    max_wait_time: 300,
    wrap_up_time: 15,
    max_engagement_in_queue: 1,

    // Add other fields as you discover them.
    // Leaving extras here is fine—Zoom will reject unknown fields with a helpful error.
  };
}

function sampleCsvTemplate() {
  return [
    "queue_name,queue_description",
    "Example Voice Queue,Created from template batch",
    "Example Queue 2,Another queue created from template batch",
  ].join("\n");
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [queues, setQueues] = useState<Queue[]>([]);
  const [activeTab, setActiveTab] = useState<"list" | "create" | "bulk">("list");

  /** ---- Edit modal state ---- */
  const [editing, setEditing] = useState<Queue | null>(null);
  const [originalQueue, setOriginalQueue] = useState<any>(null);
  const [editJsonText, setEditJsonText] = useState<string>("");
  const [patchResult, setPatchResult] = useState<string>("");

  // PATCH confirm modal
  const [patchConfirmOpen, setPatchConfirmOpen] = useState(false);
  const [computedPatch, setComputedPatch] = useState<any>(null);
  const [editedParsed, setEditedParsed] = useState<any>(null);
  const [patchBusy, setPatchBusy] = useState(false);

  // Delete confirm
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  /** ---- Create tab ---- */
  const [createJsonText, setCreateJsonText] = useState(() => prettyJson(createQueueTemplate()));
  const [createConfirmOpen, setCreateConfirmOpen] = useState(false);
  const [createParsed, setCreateParsed] = useState<any>(null);
  const [createBusy, setCreateBusy] = useState(false);

  /** ---- Bulk tab ---- */
  const [csvText, setCsvText] = useState(sampleCsvTemplate());
  const [bulkPreviewOpen, setBulkPreviewOpen] = useState(false);
  const [bulkRows, setBulkRows] = useState<Record<string, string>[]>([]);
  const [bulkPayloads, setBulkPayloads] = useState<any[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<string>("");
    // Templates (for batch create)
  const [templates, setTemplates] = useState<QueueTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");

  async function loadTemplates() {
    setTemplatesLoading(true);
    try {
      const res = await listQueueTemplates({ page_size: "200" });
      if (!res?.ok) throw new Error(res?.message || res?.data?.message || "Failed to load templates");
      const items = pickTemplatesFromResponse(res);
      setTemplates(items);

      // Auto-pick first active template if none selected yet
      if (!selectedTemplateId && items.length) {
        const preferred = items.find((t: any) => t.template_status === "active") || items[0];
        setSelectedTemplateId(String(preferred.template_id || ""));
      }
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setTemplatesLoading(false);
    }
  }

    useEffect(() => {
    if (activeTab === "bulk" && !templatesLoading && templates.length === 0) {
      loadTemplates();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const res = await listQueues({ channel: "voice", page_size: "200" });
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

  async function openEdit(q: Queue) {
    setErr(null);
    setPatchResult("");
    setDeleteConfirmText("");
    setPatchConfirmOpen(false);
    setComputedPatch(null);
    setEditedParsed(null);

    // Open modal immediately with what we have (fast UX)
    setEditing(q);
    setOriginalQueue(q);
    setEditJsonText(prettyJson(q));

    // Then fetch the full detail payload and re-seed
    try {
      const id = String(q.queue_id || q.id || "");
      if (!id) throw new Error("Missing queue id");

      const res = await getQueue(id);
      if (!res?.ok) throw new Error(res?.message || res?.data?.message || "Failed to load queue details");

      const full = res?.data?.data ?? res?.data ?? res; // tolerate shapes

      setEditing(full);
      setOriginalQueue(full);
      setEditJsonText(prettyJson(full));
    } catch (e: any) {
      // keep modal open with list payload; just show error
      setErr(e?.message || String(e));
    }
  }


  function computePatchAndOpenConfirm() {
    if (!editing) return;
    setErr(null);

    const parsed = safeParseJson(editJsonText);
    if (!parsed.ok) {
      setErr(parsed.error);
      return;
    }

    const o = stripReadOnly(originalQueue);
    const e = stripReadOnly(parsed.value);

    const d = deepDiff(o, e);
    const patch = d ?? {};

    setComputedPatch(patch);
    setEditedParsed(parsed.value);
    setPatchConfirmOpen(true);
  }

  async function confirmPatch() {
    if (!editing) return;
    setErr(null);
    setPatchResult("");

    if (!computedPatch || Object.keys(computedPatch).length === 0) {
      setErr("No changes detected (diff is empty).");
      return;
    }

    setPatchBusy(true);
    try {
      const id = String(editing.queue_id || editing.id);
      const res = await patchQueue(id, computedPatch);
      setPatchResult(prettyJson(res));
      if (res?.ok) {
        setPatchConfirmOpen(false);
        setEditing(null);
        await refresh();
      }
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setPatchBusy(false);
    }
  }

  async function confirmDelete() {
    if (!editing) return;
    setErr(null);
    setPatchResult("");

    if (deleteConfirmText.trim().toUpperCase() !== "DELETE") {
      setErr('To delete, type DELETE in the confirmation box.');
      return;
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

  /** ---------- Create flow ---------- */
  function openCreateConfirm() {
    setErr(null);
    const parsed = safeParseJson(createJsonText);
    if (!parsed.ok) {
      setErr(parsed.error);
      return;
    }
    setCreateParsed(parsed.value);
    setCreateConfirmOpen(true);
  }

  async function confirmCreate() {
    setErr(null);
    setBulkResult("");
    setPatchResult("");
    if (!createParsed) {
      setErr("Create payload missing.");
      return;
    }

    setCreateBusy(true);
    try {
      const res = await createQueue(createParsed);
      // show result in modal body (we’ll just reuse patchResult slot)
      setPatchResult(prettyJson(res));
      if (res?.ok) {
        setCreateConfirmOpen(false);
        setActiveTab("list");
        await refresh();
      }
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setCreateBusy(false);
    }
  }

  /** ---------- Bulk flow ---------- */
  function openBulkPreview() {
    setErr(null);
    setBulkResult("");

    const rows = parseCsv(csvText);
    if (!rows.length) {
      setErr("CSV had no data rows.");
      return;
    }

    const payloads = rows.map(csvRowToCreatePayload);
    setBulkRows(rows);
    setBulkPayloads(payloads);
    setBulkPreviewOpen(true);
  }

  async function confirmBulk() {
    setErr(null);
    setBulkResult("");
    setPatchResult("");

    if (!selectedTemplateId) {
      setErr("Please select a template before creating.");
      return;
    }

    // Only send valid queue rows (must have queue_name)
    const queuesToCreate = bulkPayloads.filter((p) => p?.queue_name);
    if (!queuesToCreate.length) {
      setErr("No valid rows to create (all rows are missing queue_name).");
      return;
    }

    setBulkBusy(true);
    try {
      const res = await batchCreateQueues({
        template_id: selectedTemplateId,
        queues: queuesToCreate,
      });

      setBulkResult(prettyJson(res));

      if (res?.ok) {
        setBulkPreviewOpen(false);
        setActiveTab("list");
        await refresh();
      }
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBulkBusy(false);
    }
  }


  const tabBtn = (label: string, tab: "list" | "create" | "bulk") => (
    <button onClick={() => setActiveTab(tab)} disabled={activeTab === tab}>
      {label}
    </button>
  );

  return (
    <div style={{ fontFamily: "system-ui", padding: 20, maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ margin: 0 }}>Brook Queue Manager</h1>

      <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={refresh} disabled={loading}>Refresh</button>
        {tabBtn("Queues", "list")}
        {tabBtn("Create", "create")}
        {tabBtn("Bulk CSV", "bulk")}
        {loading && <span>Loading…</span>}
        {err && <span style={{ color: "crimson" }}>{err}</span>}
      </div>

      {/* ---------------- LIST TAB ---------------- */}
      {activeTab === "list" && (
        <div style={{ marginTop: 14 }}>
          <div style={{ opacity: 0.8, marginBottom: 8 }}>{sorted.length} queues</div>

          <table cellPadding={8} style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                <th style={{ width: 360 }}>Name</th>
                <th style={{ width: 300 }}>ID</th>
                <th style={{ width: 180 }}>Channels</th>
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

          {bulkResult && (
            <pre style={{ marginTop: 12, background: "#f7f7f7", padding: 10, borderRadius: 10, overflow: "auto" }}>
              {bulkResult}
            </pre>
          )}
        </div>
      )}

      {/* ---------------- CREATE TAB ---------------- */}
      {activeTab === "create" && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 800, marginBottom: 8 }}>Create Queue (POST)</div>
          <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>
            Edit the JSON payload. We’ll show a confirm modal before sending.
          </div>

          <textarea
            value={createJsonText}
            onChange={(e) => setCreateJsonText(e.target.value)}
            spellCheck={false}
            style={{ width: "100%", minHeight: 320, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
          />

          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button onClick={() => setCreateJsonText(prettyJson(createQueueTemplate()))}>Reset Template</button>
            <button
              onClick={openCreateConfirm}
              style={{ fontWeight: 900, background: "#0a7a2f", color: "white", border: "none", padding: "8px 12px", borderRadius: 8 }}
            >
              Review & Create…
            </button>
          </div>

          {patchResult && (
            <pre style={{ marginTop: 12, background: "#f7f7f7", padding: 10, borderRadius: 10, overflow: "auto" }}>
              {patchResult}
            </pre>
          )}
        </div>
      )}

      {/* ---------------- BULK TAB ---------------- */}
      {activeTab === "bulk" && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 800, marginBottom: 8 }}>Bulk Create from CSV</div>
          <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>
            Paste CSV below. We’ll preview parsed queues before sending to the API.
          </div>

          <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              Select a queue template. The template controls channel + defaults; CSV only provides queue name/description.
            </div>

            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <select
                value={selectedTemplateId}
                onChange={(e) => setSelectedTemplateId(e.target.value)}
                style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd", minWidth: 520 }}
                disabled={templatesLoading}
              >
                <option value="">
                  {templatesLoading ? "Loading templates…" : templates.length ? "Select a template…" : "No templates found"}
                </option>

                {templates.map((t: any) => {
                  const id = String(t.template_id || "");
                  const label = `${t.template_name || "(no name)"} — ${t.channel || "?"} — ${t.template_status || "?"}`;
                  const desc = t.template_description ? ` (${t.template_description})` : "";
                  return (
                    <option key={id} value={id}>
                      {label}
                      {desc}
                    </option>
                  );
                })}
              </select>

              <button onClick={loadTemplates} disabled={templatesLoading}>
                {templatesLoading ? "Refreshing…" : "Refresh Templates"}
              </button>
            </div>
          </div>


          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <button onClick={() => setCsvText(sampleCsvTemplate())}>Insert Sample CSV</button>
          </div>

          <textarea
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            spellCheck={false}
            style={{ width: "100%", minHeight: 260, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
          />

          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button
              onClick={openBulkPreview}
              style={{ fontWeight: 900, background: "#0a7a2f", color: "white", border: "none", padding: "8px 12px", borderRadius: 8 }}
            >
              Preview & Confirm…
            </button>
          </div>

          {bulkResult && (
            <pre style={{ marginTop: 12, background: "#f7f7f7", padding: 10, borderRadius: 10, overflow: "auto" }}>
              {bulkResult}
            </pre>
          )}
        </div>
      )}

      {/* ---------------- EDIT MODAL ---------------- */}
      {editing && (
        <Modal
          title={`Edit Queue: ${editing.queue_name || editing.name || ""}`}
          onClose={() => setEditing(null)}
          width={1000}
          footer={
            <>
              <button onClick={() => setEditing(null)}>Cancel</button>
              <button onClick={() => setEditJsonText(prettyJson(originalQueue))}>Reset</button>
              <button onClick={computePatchAndOpenConfirm} style={{ fontWeight: 900 }}>
                Review Diff…
              </button>
              <button
                onClick={confirmDelete}
                style={{
                  background: "#b00020",
                  color: "white",
                  border: "none",
                  padding: "8px 12px",
                  borderRadius: 8,
                  marginLeft: 6,
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
              Full queue object (from GET /contactcenter/queue/:queueid). We’ll compute a diff and PATCH only the changes.
            </div>

            <textarea
              value={editJsonText}
              onChange={(e) => setEditJsonText(e.target.value)}
              spellCheck={false}
              style={{ width: "100%", minHeight: 360, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
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
            </div>

            {patchResult && (
              <pre style={{ marginTop: 0, background: "#f7f7f7", padding: 10, borderRadius: 10, overflow: "auto" }}>
                {patchResult}
              </pre>
            )}
          </div>
        </Modal>
      )}

      {/* ---------------- PATCH CONFIRM MODAL ---------------- */}
      {patchConfirmOpen && editing && (
        <Modal
          title="Confirm PATCH (Diff Preview)"
          onClose={() => setPatchConfirmOpen(false)}
          width={980}
          footer={
            <>
              <button onClick={() => setPatchConfirmOpen(false)}>Back</button>
              <button
                onClick={confirmPatch}
                disabled={patchBusy || !computedPatch || Object.keys(computedPatch).length === 0}
                style={{
                  background: "#0a7a2f",
                  color: "white",
                  border: "none",
                  padding: "8px 12px",
                  borderRadius: 8,
                  fontWeight: 900,
                  opacity: patchBusy ? 0.8 : 1,
                }}
              >
                {patchBusy ? "Patching…" : "Confirm PATCH"}
              </button>
            </>
          }
        >
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ opacity: 0.85 }}>
              <div><b>Queue:</b> {editing.queue_name || editing.name || ""}</div>
              <div style={{ fontFamily: "monospace" }}><b>ID:</b> {String(editing.queue_id || editing.id)}</div>
            </div>

            {!computedPatch || Object.keys(computedPatch).length === 0 ? (
              <div style={{ color: "crimson" }}>
                No changes detected. Close this modal and edit something first.
              </div>
            ) : (
              <>
                <div style={{ fontSize: 12, opacity: 0.75 }}>Changes :</div>
                <DiffBlock
                  lines={collectDiffLines(
                    stripReadOnly(originalQueue),
                    stripReadOnly(editedParsed || {})
                  )}
                />

                <div style={{ fontSize: 12, opacity: 0.75 }}>PATCH payload (what will be sent):</div>
                <pre style={{ background: "#f7f7f7", padding: 10, borderRadius: 10, overflow: "auto" }}>
                  {prettyJson(computedPatch)}
                </pre>
              </>
            )}
          </div>
        </Modal>
      )}

      {/* ---------------- CREATE CONFIRM MODAL ---------------- */}
      {createConfirmOpen && (
        <Modal
          title="Confirm CREATE (POST)"
          onClose={() => setCreateConfirmOpen(false)}
          width={980}
          footer={
            <>
              <button onClick={() => setCreateConfirmOpen(false)}>Back</button>
              <button
                onClick={confirmCreate}
                disabled={createBusy}
                style={{
                  background: "#0a7a2f",
                  color: "white",
                  border: "none",
                  padding: "8px 12px",
                  borderRadius: 8,
                  fontWeight: 900,
                  opacity: createBusy ? 0.8 : 1,
                }}
              >
                {createBusy ? "Creating…" : "Confirm CREATE"}
              </button>
            </>
          }
        >
          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ fontSize: 12, opacity: 0.75 }}>POST payload:</div>
            <pre style={{ background: "#f7f7f7", padding: 10, borderRadius: 10, overflow: "auto" }}>
              {prettyJson(createParsed)}
            </pre>

            {patchResult && (
              <pre style={{ marginTop: 0, background: "#f7f7f7", padding: 10, borderRadius: 10, overflow: "auto" }}>
                {patchResult}
              </pre>
            )}
          </div>
        </Modal>
      )}

      {/* ---------------- BULK PREVIEW MODAL ---------------- */}
      {bulkPreviewOpen && (
        <Modal
          title="Bulk Create Preview"
          onClose={() => setBulkPreviewOpen(false)}
          width={1100}
          footer={
            <>
              <button onClick={() => setBulkPreviewOpen(false)}>Back</button>
              <button
                onClick={confirmBulk}
                disabled={bulkBusy}
                style={{
                  background: "#0a7a2f",
                  color: "white",
                  border: "none",
                  padding: "8px 12px",
                  borderRadius: 8,
                  fontWeight: 900,
                  opacity: bulkBusy ? 0.8 : 1,
                }}
              >
                {bulkBusy ? "Creating…" : `Confirm Create (${bulkPayloads.filter(p => p?.queue_name).length})`}
              </button>
            </>
          }
        >
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              Preview of parsed rows (green = ready, red = missing queue_name).
            </div>

           <div style={{ fontSize: 12, opacity: 0.8 }}>
              <b>Template:</b>{" "}
              {templates.find((t: any) => String(t.template_id) === String(selectedTemplateId))?.template_name || selectedTemplateId || "(none)"}
            </div>

            <div style={{ border: "1px solid #eee", borderRadius: 12, overflow: "hidden" }}>
              <table cellPadding={8} style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid #eee", background: "#fafafa" }}>
                    <th style={{ width: 40 }}>#</th>
                    <th style={{ width: 360 }}>queue_name</th>
                    <th>queue_description</th>
                  </tr>
                </thead>
                <tbody>
                  {bulkPayloads.map((p, idx) => {
                    const ok = !!p.queue_name;
                    return (
                      <tr key={idx} style={{ borderBottom: "1px solid #f2f2f2", background: ok ? "#f4fbf6" : "#fff5f5" }}>
                        <td>{idx + 1}</td>
                        <td style={{ fontWeight: 700 }}>{p.queue_name || "(missing)"}</td>
                        <td>{p.queue_description || ""}</td>
                      </tr>
                    );
                  })}
                </tbody>

              </table>
            </div>

            <details>
              <summary style={{ cursor: "pointer" }}>Show raw payloads</summary>
              <pre style={{ marginTop: 10, background: "#f7f7f7", padding: 10, borderRadius: 10, overflow: "auto" }}>
                {prettyJson(bulkPayloads)}
              </pre>
            </details>

            {bulkResult && (
              <pre style={{ marginTop: 0, background: "#f7f7f7", padding: 10, borderRadius: 10, overflow: "auto" }}>
                {bulkResult}
              </pre>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
