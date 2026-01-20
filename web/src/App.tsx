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

type DiffLine = { kind: "add" | "remove" | "ctx"; text: string };

function isObj(x: any) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function fmt(v: any) {
  if (typeof v === "string") return JSON.stringify(v);
  return JSON.stringify(v);
}

function collectDiffLines(a: any, b: any, path = ""): DiffLine[] {
  // identical
  if (a === b) return [];

  // arrays: replace if different
  if (Array.isArray(a) || Array.isArray(b)) {
    const as = JSON.stringify(a);
    const bs = JSON.stringify(b);
    if (as === bs) return [];
    return [
      { kind: "remove", text: `- ${path || "<root>"}: ${as}` },
      { kind: "add", text: `+ ${path || "<root>"}: ${bs}` },
    ];
  }

  // primitives or null or type change: replace
  const aIsObj = isObj(a);
  const bIsObj = isObj(b);
  if (!aIsObj || !bIsObj) {
    return [
      { kind: "remove", text: `- ${path || "<root>"}: ${fmt(a)}` },
      { kind: "add", text: `+ ${path || "<root>"}: ${fmt(b)}` },
    ];
  }

  // objects: recurse
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

// Deep diff: returns only changed keys, recursively.
// - If no changes => {}
// - Arrays: if changed in any way, replaces entire array (safe for PATCH payloads)
function deepDiff(original: any, edited: any): any {
  if (original === edited) return undefined;

  const oType = typeof original;
  const eType = typeof edited;

  // If either is null/undefined or primitive or type changed: replace
  if (
    original == null ||
    edited == null ||
    oType !== "object" ||
    eType !== "object" ||
    Array.isArray(original) ||
    Array.isArray(edited)
  ) {
    // If both arrays, do "replace if different"
    if (Array.isArray(original) && Array.isArray(edited)) {
      if (JSON.stringify(original) === JSON.stringify(edited)) return undefined;
      return edited;
    }
    return edited;
  }

  // Both objects
  const out: any = {};
  const keys = new Set([...Object.keys(original), ...Object.keys(edited)]);
  for (const k of keys) {
    // If key removed in edited, skip by default (safer). If you want deletions, we can support nulling.
    if (!(k in edited)) continue;

    const d = deepDiff(original[k], edited[k]);
    if (d !== undefined) out[k] = d;
  }
  return Object.keys(out).length ? out : undefined;
}

// Common read-only keys: strip from BOTH sides before diffing so they never appear in patch.
function stripReadOnly(obj: any) {
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

export default function App() {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [queues, setQueues] = useState<Queue[]>([]);
  const [activeTab, setActiveTab] = useState<"list" | "create" | "bulk">("list");

  // Edit modal state
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

  function openEdit(q: Queue) {
    setEditing(q);
    setOriginalQueue(q);
    setEditJsonText(prettyJson(q)); // show full GET payload
    setPatchResult("");
    setDeleteConfirmText("");
    setPatchConfirmOpen(false);
    setComputedPatch(null);
  }

  function computePatchAndOpenConfirm() {
    if (!editing) return;
    setErr(null);

    const parsed = safeParseJson(editJsonText);
    if (!parsed.ok) {
      setErr(parsed.error);
      return;
    }

    // Strip read-only keys before diff
    const o = stripReadOnly(originalQueue);
    const e = stripReadOnly(parsed.value);

    const d = deepDiff(o, e);
    const patch = d ?? {}; // if undefined => no changes
    
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

  return (
    <div style={{ fontFamily: "system-ui", padding: 20, maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ margin: 0 }}>Brook Queue Manager</h1>

      <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={refresh} disabled={loading}>Refresh</button>
        <button onClick={() => setActiveTab("list")} disabled={activeTab === "list"}>Queues</button>
        {loading && <span>Loading…</span>}
        {err && <span style={{ color: "crimson" }}>{err}</span>}
      </div>

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
            </tbody>
          </table>
        </div>
      )}

      {/* Edit Modal */}
      {editing && (
        <Modal
          title={`Edit Queue: ${editing.queue_name || editing.name || ""}`}
          onClose={() => setEditing(null)}
          width={1000}
          footer={
            <>
              <button onClick={() => setEditing(null)}>Cancel</button>
              <button
                onClick={computePatchAndOpenConfirm}
                style={{ fontWeight: 800 }}
              >
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
              Edit the full object (from GET). We’ll compute a diff and PATCH only the changes.
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
              <button onClick={() => setEditJsonText(prettyJson(originalQueue))}>Reset</button>
            </div>

            {patchResult && (
              <pre style={{ marginTop: 0, background: "#f7f7f7", padding: 10, borderRadius: 10, overflow: "auto" }}>
                {patchResult}
              </pre>
            )}
          </div>
        </Modal>
      )}

      {/* Patch Diff Confirm Modal */}
      {patchConfirmOpen && editing && (
        <Modal
          title="Confirm PATCH (Diff Preview)"
          onClose={() => setPatchConfirmOpen(false)}
          width={900}
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
          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ opacity: 0.8 }}>
              <div><b>Queue:</b> {editing.queue_name || editing.name || ""}</div>
              <div style={{ fontFamily: "monospace" }}><b>ID:</b> {String(editing.queue_id || editing.id)}</div>
            </div>

            {!computedPatch || Object.keys(computedPatch).length === 0 ? (
              <div style={{ color: "crimson" }}>
                No changes detected. Close this modal and edit something first.
              </div>
            ) : (
              <>
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  Changes (git-style diff):
                </div>

                <DiffBlock
                    lines={collectDiffLines(
                      stripReadOnly(originalQueue),
                      stripReadOnly(editedParsed || {})
                    
                  )}
                />

                <div style={{ fontSize: 12, opacity: 0.75, marginTop: 12 }}>
                  PATCH payload (what will be sent):
                </div>

                <pre style={{ background: "#f7f7f7", padding: 10, borderRadius: 10, overflow: "auto" }}>
                  {prettyJson(computedPatch)}
                </pre>
              </>

            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
