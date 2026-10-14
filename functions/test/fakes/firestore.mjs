// Minimal in-memory Firestore (Admin SDK surface used by the functions).
export const store = new Map(); // path -> data
const SENTINEL = Symbol("fv");
export const FieldValue = {
  serverTimestamp: () => ({ [SENTINEL]: "ts" }),
  arrayUnion: (...items) => ({ [SENTINEL]: "union", items }),
  delete: () => ({ [SENTINEL]: "delete" })
};
export class Timestamp { constructor(d) { this.d = d; } toDate() { return this.d; } static now() { return new Timestamp(new Date()); } }
const clone = v => structuredClone(v);
const isPlain = v => v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Timestamp) && !v[SENTINEL] && !v.__ts;

function applyValue(cur, v) {
  if (v && v[SENTINEL] === "ts") return { __ts: new Date().toISOString() };
  if (v && v[SENTINEL] === "union") { const arr = Array.isArray(cur) ? [...cur] : []; for (const i of v.items) if (!arr.some(x => JSON.stringify(x) === JSON.stringify(i))) arr.push(clone(i)); return arr; }
  if (isPlain(v)) { const out = {}; for (const [k, x] of Object.entries(v)) { const r = applyValue(undefined, x); if (!(x && x[SENTINEL] === "delete")) out[k] = r; } return out; }
  return clone(v);
}
function deepMerge(target, src) {
  const out = { ...(target || {}) };
  for (const [k, v] of Object.entries(src)) {
    if (v && v[SENTINEL] === "delete") { delete out[k]; continue; }
    if (isPlain(v) && isPlain(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = applyValue(out[k], v);
  }
  return out;
}
function setPath(obj, path, v) {
  const parts = path.split(".");
  let o = obj;
  for (const p of parts.slice(0, -1)) { if (!isPlain(o[p])) o[p] = {}; o = o[p]; }
  const last = parts.at(-1);
  if (v && v[SENTINEL] === "delete") delete o[last]; else o[last] = applyValue(o[last], v);
}
const getField = (d, f) => f.split(".").reduce((o, k) => o?.[k], d);

class Snap {
  constructor(ref, data) { this.ref = ref; this.id = ref.id; this._d = data; this.exists = data !== undefined; }
  data() { return this._d === undefined ? undefined : clone(this._d); }
}
let autoId = 0;
class DocRef {
  constructor(path) { this.path = path; this.id = path.split("/").at(-1); }
  get parent() { return new CollRef(this.path.split("/").slice(0, -1).join("/")); }
  async get() { return new Snap(this, store.get(this.path)); }
  async set(d, o) { write(this, "set", d, o); }
  async update(d) { write(this, "update", d); }
  async create(d) { write(this, "create", d); }
  async delete() { store.delete(this.path); }
}
function write(ref, kind, d, o = {}) {
  const cur = store.get(ref.path);
  if (kind === "create" && cur !== undefined) { const e = new Error(`ALREADY_EXISTS: ${ref.path}`); e.code = 6; throw e; }
  if (kind === "update" && cur === undefined) { const e = new Error(`NOT_FOUND: ${ref.path}`); e.code = 5; throw e; }
  if (kind === "update") { const n = clone(cur); for (const [k, v] of Object.entries(d)) setPath(n, k, v); store.set(ref.path, n); }
  else if (o.merge) store.set(ref.path, deepMerge(cur, d));
  else store.set(ref.path, applyValue(undefined, d));
}
class Query {
  constructor(coll, filters = [], lim = null, order = null) { this.coll = coll; this.filters = filters; this.lim = lim; this.order = order; }
  where(f, op, v) { return new Query(this.coll, [...this.filters, { f, op, v }], this.lim, this.order); }
  limit(n) { return new Query(this.coll, this.filters, n, this.order); }
  orderBy(f, dir = "asc") { return new Query(this.coll, this.filters, this.lim, { f, dir }); }
  _run() {
    const prefix = this.coll + "/";
    let docs = [...store.entries()].filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
      .filter(([, d]) => this.filters.every(({ f, op, v }) => {
        const x = getField(d, f);
        if (op === "==") return x === v;
        if (op === "in") return v.includes(x);
        if (op === "!=") return x !== v;
        throw new Error("op " + op);
      })).map(([p, d]) => new Snap(new DocRef(p), d));
    if (this.order) { const k = d => { const v = getField(d._d, this.order.f); return v?.__ts || v || ""; }; docs.sort((a, b) => (k(a) > k(b) ? 1 : k(a) < k(b) ? -1 : 0) * (this.order.dir === "desc" ? -1 : 1)); }
    if (this.lim) docs = docs.slice(0, this.lim);
    return docs;
  }
  async get() { const docs = this._run(); return { docs, empty: !docs.length, size: docs.length }; }
  count() { return { get: async () => ({ data: () => ({ count: this._run().length }) }) }; }
}
class CollRef extends Query {
  constructor(path) { super(path); this.path = path; }
  doc(id) { return new DocRef(`${this.path}/${id || "auto" + (++autoId).toString(36).padStart(12, "0")}`); }
}
class Batch {
  constructor() { this.ops = []; }
  set(r, d, o) { this.ops.push(() => write(r, "set", d, o)); return this; }
  update(r, d) { this.ops.push(() => write(r, "update", d)); return this; }
  create(r, d) { this.ops.push(() => write(r, "create", d)); return this; }
  delete(r) { this.ops.push(() => store.delete(r.path)); return this; }
  async commit() {
    const backup = new Map(store);
    try { for (const op of this.ops) op(); } catch (e) { store.clear(); for (const [k, v] of backup) store.set(k, v); throw e; }
  }
}
class Tx extends Batch {
  constructor() { super(); this.wrote = false; }
  async get(r) { if (this.ops.length) throw new Error("Transaction read after write"); return r instanceof Query ? r.get() : r.get(); }
}
export function getFirestore() {
  return {
    settings() {},
    doc: p => new DocRef(p), collection: p => new CollRef(p), batch: () => new Batch(),
    async runTransaction(fn) { const tx = new Tx(); const r = await fn(tx); await tx.commit(); return r; }
  };
}
