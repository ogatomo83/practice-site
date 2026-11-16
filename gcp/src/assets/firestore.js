// Firestore：データベース（ネイティブ モード / Datastore モード）、複合インデックス、Node の SDK（@google-cloud/firestore）。
// 状態：w.svc.firestore.dbs['proj/(default)'] = { location, type, created, docs: { 'col/id': { f: {…}, c: 作成時刻, u: 更新時刻 } }, indexes: [{ id, cg, fields: [[path, 'ASCENDING'|'DESCENDING']], state }] }
// 値は JSON にできる形で持つ：Timestamp は { __ts: ミリ秒 }
(function (root) {
  'use strict';
  const G = root.GCP = root.GCP || {};
  const E = G.E;
  G.SERVICES_INIT.firestore = () => ({ dbs: {} });
  const D = (w) => w.svc.firestore;
  const SVC = 'firestore.googleapis.com';

  // ---------------------------------------------------------------- gcloud firestore databases / indexes
  const dbView = (w, k, d) => {
    const [pid, name] = k.split('/');
    return { appEngineIntegrationMode: 'DISABLED', concurrencyMode: 'PESSIMISTIC', createTime: G.iso(d.created, 6), deleteProtectionState: 'DELETE_PROTECTION_DISABLED', earliestVersionTime: G.iso(Math.max(d.created, w.t - 3600000), 6), etag: G.alnum('fdb' + k, 14), freeTier: name === '(default)' ? true : undefined, keyPrefix: undefined, locationId: d.location, name: `projects/${pid}/databases/${name}`, pointInTimeRecoveryEnablement: 'POINT_IN_TIME_RECOVERY_DISABLED', type: d.type, uid: G.uuid('fdb' + k), updateTime: G.iso(d.created, 6), versionRetentionPeriod: '3600s', databaseEdition: 'STANDARD' };
  };
  G.gc('firestore databases create', { flags: { location: 'v', type: 'v', database: 'v', 'delete-protection': 'b' }, req: ['location'], fmt: 'yaml', run: async (c) => {
    const pid = c.need();
    const name = c.a.database || '(default)';
    c.call({ method: 'google.firestore.admin.v1.FirestoreAdmin.CreateDatabase', perm: 'datastore.databases.create', res: 'projects/' + pid, svc: SVC, project: pid, billable: name !== '(default)', resType: 'audited_resource' });
    const k = `${pid}/${name}`;
    if (D(c.w).dbs[k]) throw new G.Err(409, 'ALREADY_EXISTS', `Database already exists. Please use another database_id`);
    if (name !== '(default)' && !/^[a-z][a-z0-9-]{3,61}[a-z0-9]$/.test(name)) throw new G.Err(400, 'INVALID_ARGUMENT', `Database ID '${name}' is not valid. The database ID must be 4-63 characters. Valid characters are /[a-z][0-9]-/ with first character a letter and the last a letter or a number. Must not be UUID-like /[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/.`);
    if (c.a.type && !['firestore-native', 'datastore-mode'].includes(c.a.type)) throw E.usage(`argument --type: Invalid choice: '${c.a.type}'.`);
    const type = (c.a.type || 'firestore-native') === 'datastore-mode' ? 'DATASTORE_MODE' : 'FIRESTORE_NATIVE';
    D(c.w).dbs[k] = { location: c.a.location, type, created: c.w.t, docs: {}, indexes: [] };
    G.tick(c.w, 20000);
    return { metadata: { '@type': 'type.googleapis.com/google.firestore.admin.v1.CreateDatabaseMetadata' }, name: `projects/${pid}/databases/${name}/operations/${G.uuid('fop' + k)}`, done: true, response: Object.assign({ '@type': 'type.googleapis.com/google.firestore.admin.v1.Database' }, dbView(c.w, k, D(c.w).dbs[k])) };
  } });
  G.gc('firestore databases list', { fmt: 'yaml', run: async (c) => {
    const pid = c.need();
    c.call({ method: 'ListDatabases', perm: 'datastore.databases.list', res: 'projects/' + pid, svc: SVC, project: pid, read: true });
    return { databases: Object.entries(D(c.w).dbs).filter(([k]) => k.startsWith(pid + '/')).map(([k, d]) => dbView(c.w, k, d)) };
  } });
  G.gc('firestore databases describe', { flags: { database: 'v' }, fmt: 'yaml', run: async (c) => {
    const pid = c.need();
    const k = `${pid}/${c.a.database || '(default)'}`;
    c.call({ method: 'GetDatabase', perm: 'datastore.databases.get', res: 'projects/' + pid, svc: SVC, project: pid, read: true });
    if (!D(c.w).dbs[k]) throw new G.Err(404, 'NOT_FOUND', `Project '${pid}' or database '${c.a.database || '(default)'}' does not exist.`);
    return dbView(c.w, k, D(c.w).dbs[k]);
  } });
  G.gc('firestore databases delete', { flags: { database: 'v' }, req: ['database'], fmt: 'yaml', run: async (c) => {
    const pid = c.need();
    const k = `${pid}/${c.a.database}`;
    c.call({ method: 'DeleteDatabase', perm: 'datastore.databases.delete', res: 'projects/' + pid, svc: SVC, project: pid });
    if (!D(c.w).dbs[k]) throw new G.Err(404, 'NOT_FOUND', `Project '${pid}' or database '${c.a.database}' does not exist.`);
    c.confirm(`The database 'projects/${pid}/databases/${c.a.database}' will be deleted.`);
    const v = dbView(c.w, k, D(c.w).dbs[k]);
    delete D(c.w).dbs[k];
    return v;
  } });
  const parseFieldConfig = (s) => { const o = {}; for (const kv of s.split(',')) { const [a, b] = kv.split('='); o[a.trim()] = (b || '').trim(); } return [o['field-path'], (o.order || 'ascending').toUpperCase() === 'DESCENDING' ? 'DESCENDING' : 'ASCENDING']; };
  const idxView = (pid, db, x) => ({ apiScope: 'ANY_API', fields: x.fields.map(([p, o]) => ({ fieldPath: p, order: o })).concat([{ fieldPath: '__name__', order: x.fields[x.fields.length - 1][1] }]), name: `projects/${pid}/databases/${db}/collectionGroups/${x.cg}/indexes/${x.id}`, queryScope: 'COLLECTION', state: x.state, density: 'SPARSE_ALL' });
  G.gc('firestore indexes composite create', { flags: { 'collection-group': 'v', 'field-config': 'v*', database: 'v', async: 'b', 'query-scope': 'v' }, req: ['collection-group', 'field-config'], run: async (c) => {
    const pid = c.need();
    const db = c.a.database || '(default)';
    const d = D(c.w).dbs[`${pid}/${db}`];
    c.call({ method: 'CreateIndex', perm: 'datastore.indexes.create', res: 'projects/' + pid, svc: SVC, project: pid });
    if (!d) throw new G.Err(404, 'NOT_FOUND', `Project '${pid}' or database '${db}' does not exist.`);
    const fields = c.a['field-config'].map(parseFieldConfig);
    if (fields.length < 2) throw new G.Err(400, 'INVALID_ARGUMENT', 'Composite indexes must have at least 2 fields. Single field indexes are managed automatically.');
    if (d.indexes.some((x) => x.cg === c.a['collection-group'] && JSON.stringify(x.fields) === JSON.stringify(fields))) throw new G.Err(409, 'ALREADY_EXISTS', 'index already exists');
    const id = 'CICAg' + G.alnum('idx' + G.seq(c.w, 'fidx'), 9).toUpperCase().replace(/[0-9]/g, 'J') + 'oK';
    d.indexes.push({ id, cg: c.a['collection-group'], fields, state: 'READY' });
    G.tick(c.w, 60000);
    c.err(`Create request issued\nWaiting for operation [projects/${pid}/databases/${db}/operations/${G.alnum('iop' + id, 14)}] to complete...done.\nCreated index [${id}].\n`);
  } });
  G.gc('firestore indexes composite list', { flags: { database: 'v' }, fmt: 'table(name.basename():label=NAME, name.segment(-3):label=COLLECTION_GROUP, queryScope:label=QUERY_SCOPE, state:label=STATE, apiScope:label=API_SCOPE, fieldsText:label=FIELDS)', run: async (c) => {
    const pid = c.need();
    const db = c.a.database || '(default)';
    const d = D(c.w).dbs[`${pid}/${db}`];
    c.call({ method: 'ListIndexes', perm: 'datastore.indexes.list', res: 'projects/' + pid, svc: SVC, project: pid, read: true });
    if (!d) throw new G.Err(404, 'NOT_FOUND', `Project '${pid}' or database '${db}' does not exist.`);
    return d.indexes.map((x) => Object.assign(idxView(pid, db, x), { fieldsText: x.fields.map(([p, o]) => `${p}:${o === 'ASCENDING' ? 'ASC' : 'DESC'}`).join(',') }));
  } });

  // ---------------------------------------------------------------- 値
  class Timestamp {
    constructor(seconds, nanoseconds) { this._seconds = seconds; this._nanoseconds = nanoseconds || 0; }
    static fromMillis(ms) { return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6); }
    static fromDate(d) { return Timestamp.fromMillis(d.getTime()); }
    get seconds() { return this._seconds; } get nanoseconds() { return this._nanoseconds; }
    toMillis() { return this._seconds * 1000 + Math.floor(this._nanoseconds / 1e6); }
    toDate() { return new Date(this.toMillis()); }
    isEqual(o) { return o && o.toMillis && o.toMillis() === this.toMillis(); }
    __inspect() { return `Timestamp { _seconds: ${this._seconds}, _nanoseconds: ${this._nanoseconds} }`; }
    toJSON() { return { _seconds: this._seconds, _nanoseconds: this._nanoseconds }; }
  }
  const FV = {
    serverTimestamp: () => ({ __fv: 'ts' }), increment: (n) => ({ __fv: 'inc', n }), delete: () => ({ __fv: 'del' }),
    arrayUnion: (...a) => ({ __fv: 'union', a }), arrayRemove: (...a) => ({ __fv: 'remove', a }),
  };
  // 読者の値 → 保存の形
  function enc(v, w, prev) {
    if (v instanceof Timestamp) return { __ts: v.toMillis() };
    if (v instanceof Date) return { __ts: v.getTime() };
    if (v && v.__fv === 'ts') return { __ts: G.T0 + w.t };
    if (v && v.__fv === 'inc') return (typeof prev === 'number' ? prev : 0) + v.n;
    if (v && v.__fv === 'union') { const a = Array.isArray(prev) ? prev.slice() : []; for (const x of v.a) if (!a.some((y) => JSON.stringify(y) === JSON.stringify(enc(x, w)))) a.push(enc(x, w)); return a; }
    if (v && v.__fv === 'remove') { const a = Array.isArray(prev) ? prev.slice() : []; return a.filter((y) => !v.a.some((x) => JSON.stringify(enc(x, w)) === JSON.stringify(y))); }
    if (v && v.__ref) return { __ref: v.path };
    if (Array.isArray(v)) return v.map((x) => enc(x, w));
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) { if (v[k] === undefined) throw sdkErr(3, `Cannot use "undefined" as a Firestore value (found in field "${k}"). If you want to ignore undefined values, enable \`ignoreUndefinedProperties\`.`); if (!(v[k] && v[k].__fv === 'del')) o[k] = enc(v[k], w, prev && prev[k]); } return o; }
    if (typeof v === 'function') throw sdkErr(3, 'Cannot use a function as a Firestore value');
    return v;
  }
  function dec(v, db) {
    if (v && v.__ts !== undefined) return Timestamp.fromMillis(v.__ts);
    if (v && v.__ref !== undefined) return db ? db.doc(v.__ref) : v.__ref;
    if (Array.isArray(v)) return v.map((x) => dec(x, db));
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = dec(v[k], db); return o; }
    return v;
  }
  const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
  const setPath = (o, p, v) => { const ks = p.split('.'); let x = o; for (let j = 0; j < ks.length - 1; j++) x = x[ks[j]] = x[ks[j]] && typeof x[ks[j]] === 'object' ? x[ks[j]] : {}; if (v === undefined) delete x[ks[ks.length - 1]]; else x[ks[ks.length - 1]] = v; };
  // 値の並び順（型の順：null < 真偽 < 数 < 時刻 < 文字列 < …）
  const typeRank = (v) => (v === null || v === undefined ? 0 : typeof v === 'boolean' ? 1 : typeof v === 'number' ? 2 : v && v.__ts !== undefined ? 3 : typeof v === 'string' ? 4 : Array.isArray(v) ? 7 : 8);
  const cmpVal = (a, b) => {
    const ra = typeRank(a), rb = typeRank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 3) return a.__ts - b.__ts;
    if (ra === 2) return a - b;
    if (ra === 1) return (a ? 1 : 0) - (b ? 1 : 0);
    if (ra === 4) return a < b ? -1 : a > b ? 1 : 0;
    return JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0;
  };
  const sdkErr = (code, details) => { const names = { 3: 'INVALID_ARGUMENT', 5: 'NOT_FOUND', 6: 'ALREADY_EXISTS', 7: 'PERMISSION_DENIED', 9: 'FAILED_PRECONDITION', 10: 'ABORTED' }; const e = new Error(`${code} ${names[code]}: ${details}`); e.code = code; e.details = details; return e; };
  const autoId = (w) => G.alnum('fsid' + G.seq(w, 'fsid'), 20).replace(/^[0-9]/, 'K').split('').map((ch, i) => (G.hash('c' + i + ch + w.t) % 2 ? ch.toUpperCase() : ch)).join('');
  G.FsTimestamp = Timestamp;

  // ---------------------------------------------------------------- SDK
  G.NODE_MODULES['@google-cloud/firestore'] = (env) => {
    const w = env.w;
    class Firestore {
      constructor(o = {}) { this.projectId = o.projectId || env.project; this.databaseId = o.databaseId || '(default)'; }
      _db(perm) {
        const p = w.projects[this.projectId];
        if (!p) throw sdkErr(7, `Permission denied on resource project ${this.projectId}.`);
        if (!p.services.includes(SVC)) throw sdkErr(7, `Cloud Firestore API has not been used in project ${this.projectId} before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/firestore.googleapis.com/overview?project=${p.projectNumber} then retry.`);
        const d = D(w).dbs[`${this.projectId}/${this.databaseId}`];
        if (!d) throw sdkErr(5, `The database ${this.databaseId} does not exist for project ${this.projectId} Please visit https://console.cloud.google.com/datastore/setup?project=${this.projectId} to add a Cloud Datastore or Cloud Firestore database.`);
        if (d.type === 'DATASTORE_MODE') throw sdkErr(9, `The Cloud Firestore API is not available for Firestore in Datastore Mode database projects/${this.projectId}/databases/${this.databaseId}.`);
        if (perm) { G.KNOWN.add(perm); if (!env.who || !G.check(w, env.who, perm, 'projects/' + this.projectId).ok) throw sdkErr(7, 'Missing or insufficient permissions.'); }
        G.tick(w, 15);
        return d;
      }
      collection(p) { return new CollRef(this, p); }
      doc(p) { return new DocRef(this, p); }
      collectionGroup(id) { return new Query(this, null, { group: id }); }
      batch() { return new Batch(this); }
      async runTransaction(fn) { const t = new Txn(this); const r = await fn(t); await t._commit(); return r; }
      async listCollections() { const d = this._db('datastore.entities.list'); return [...new Set(Object.keys(d.docs).map((k) => k.split('/')[0]))].sort().map((n) => new CollRef(this, n)); }
      async getAll(...refs) { return Promise.all(refs.map((r) => r.get())); }
      async terminate() {}
    }
    Firestore.FieldValue = FV;
    Firestore.Timestamp = Timestamp;
    Firestore.FieldPath = { documentId: () => '__name__' };
    class DocRef {
      constructor(db, path) {
        if (path.split('/').filter(Boolean).length % 2) throw new Error(`Value for argument "documentPath" must point to a document, but was "${path}". Your path does not contain an even number of components.`);
        this.firestore = db; this.path = path.replace(/^\/|\/$/g, ''); this.id = this.path.split('/').pop(); this.__ref = true;
      }
      get parent() { return new CollRef(this.firestore, this.path.split('/').slice(0, -1).join('/')); }
      collection(p) { return new CollRef(this.firestore, this.path + '/' + p); }
      async get() { const d = this.firestore._db('datastore.entities.get'); return new DocSnap(this, d.docs[this.path]); }
      _write(d, data, mode) {
        const cur = d.docs[this.path];
        if (mode === 'create' && cur) throw sdkErr(6, `Document already exists: projects/${this.firestore.projectId}/databases/${this.firestore.databaseId}/documents/${this.path}`);
        if (mode === 'update' && !cur) throw sdkErr(5, `No document to update: projects/${this.firestore.projectId}/databases/${this.firestore.databaseId}/documents/${this.path}`);
        let f;
        if (mode === 'update') { f = G.clone(cur.f); for (const [k, v] of Object.entries(data)) { const prev = getPath(f, k); setPath(f, k, v && v.__fv === 'del' ? undefined : enc(v, w, prev)); } }
        else if (mode === 'merge') { f = cur ? G.clone(cur.f) : {}; const walk = (src, pre) => { for (const [k, v] of Object.entries(src)) { const p = pre ? pre + '.' + k : k; if (v && typeof v === 'object' && !Array.isArray(v) && !v.__fv && !(v instanceof Timestamp) && !(v instanceof Date) && !v.__ref) walk(v, p); else setPath(f, p, v && v.__fv === 'del' ? undefined : enc(v, w, getPath(f, p))); } }; walk(data, ''); }
        else f = enc(data, w, cur && cur.f);
        d.docs[this.path] = { f, c: cur ? cur.c : G.T0 + w.t, u: G.T0 + w.t };
        return { writeTime: Timestamp.fromMillis(G.T0 + w.t) };
      }
      async set(data, o = {}) { const d = this.firestore._db(o.merge ? 'datastore.entities.update' : 'datastore.entities.create'); if (o.merge && !d.docs[this.path]) this.firestore._db('datastore.entities.create'); return this._write(d, data, o.merge ? 'merge' : 'set'); }
      async create(data) { const d = this.firestore._db('datastore.entities.create'); return this._write(d, data, 'create'); }
      async update(data, ...more) { if (typeof data === 'string') { const o = {}; o[data] = more[0]; for (let j = 1; j + 1 < more.length + 1; j += 2) if (more[j] !== undefined) o[more[j]] = more[j + 1]; data = o; } const d = this.firestore._db('datastore.entities.update'); return this._write(d, data, 'update'); }
      async delete() { const d = this.firestore._db('datastore.entities.delete'); delete d.docs[this.path]; return { writeTime: Timestamp.fromMillis(G.T0 + w.t) }; }
      async listCollections() { const d = this.firestore._db('datastore.entities.list'); const pre = this.path + '/'; return [...new Set(Object.keys(d.docs).filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length).split('/')[0]))].map((n) => this.collection(n)); }
      __inspect() { return `DocumentReference { path: '${this.path}' }`; }
    }
    class DocSnap {
      constructor(ref, rec) { this.ref = ref; this.id = ref.id; this._rec = rec; this.exists = !!rec; this.createTime = rec ? Timestamp.fromMillis(rec.c) : undefined; this.updateTime = rec ? Timestamp.fromMillis(rec.u) : undefined; this.readTime = Timestamp.fromMillis(G.T0 + w.t); }
      data() { return this._rec ? dec(this._rec.f, this.ref.firestore) : undefined; }
      get(p) { return this._rec ? dec(getPath(this._rec.f, p), this.ref.firestore) : undefined; }
    }
    class Query {
      constructor(db, coll, o = {}) { this.firestore = db; this._coll = coll; this._o = Object.assign({ wh: [], ob: [], lim: null, off: 0, group: null, sel: null, startAfter: null }, o); }
      _with(ch) { return new Query(this.firestore, this._coll, Object.assign({}, this._o, ch)); }
      where(f, op, v) { if (f && typeof f === 'object' && f.__filter) return this._with({ wh: this._o.wh.concat(f.list) }); return this._with({ wh: this._o.wh.concat([[f, op, v]]) }); }
      orderBy(f, dir) { return this._with({ ob: this._o.ob.concat([[f, (dir || 'asc').toLowerCase() === 'desc' ? 'DESCENDING' : 'ASCENDING']]) }); }
      limit(n) { return this._with({ lim: n }); }
      offset(n) { return this._with({ off: n }); }
      select(...f) { return this._with({ sel: f }); }
      startAfter(...v) { return this._with({ startAfter: v }); }
      count() { const q = this; return { get: async () => { const s = await q.get(); return { data: () => ({ count: s.size }) }; } }; }
      async get() {
        const d = this.firestore._db('datastore.entities.list');
        const o = this._o;
        const ops = ['<', '<=', '==', '!=', '>=', '>', 'array-contains', 'in', 'not-in', 'array-contains-any'];
        for (const [f, op] of o.wh) if (!ops.includes(op)) throw new Error(`Value for argument "opStr" is invalid. Acceptable values are: ${ops.join(', ')}`);
        // 複合インデックスが要るか
        const eq = [...new Set(o.wh.filter(([, op]) => op === '==' || op === 'array-contains' || op === 'in').map(([f]) => f))];
        const range = [...new Set(o.wh.filter(([, op]) => ['<', '<=', '>', '>=', '!=', 'not-in'].includes(op)).map(([f]) => f))];
        if (range.length > 1 && !o.ob.length) {}
        const order = o.ob.slice();
        for (const r of range) if (!order.some(([f]) => f === r)) order.unshift([r, 'ASCENDING']);
        const cg = o.group || (this._coll ? this._coll.split('/').pop() : '');
        const needIndex = order.length > 1 || (eq.length > 0 && order.length > 0 && !(order.length === 1 && eq.includes(order[0][0])));
        if (needIndex) {
          const flip = (x) => (x === 'ASCENDING' ? 'DESCENDING' : 'ASCENDING');
          const ok = d.indexes.some((x) => {
            if (x.cg !== cg || x.state !== 'READY' || x.fields.length !== eq.length + order.length) return false;
            const head = x.fields.slice(0, eq.length).map(([p]) => p).sort();
            if (JSON.stringify(head) !== JSON.stringify(eq.slice().sort())) return false;
            const tail = x.fields.slice(eq.length);
            const same = order.every(([f, dd], j) => tail[j][0] === f && tail[j][1] === dd);
            const rev = order.every(([f, dd], j) => tail[j][0] === f && tail[j][1] === flip(dd));
            return same || rev;
          });
          if (!ok) {
            const fieldsCfg = eq.map((f) => [f, 'ASCENDING']).concat(order);
            const enc2 = G.b64enc(`\n${this.firestore.projectId}/${cg}/${fieldsCfg.map(([f, dd]) => f + (dd === 'DESCENDING' ? '-' : '')).join(',')}`).replace(/=+$/, '');
            throw sdkErr(9, `The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/${this.firestore.projectId}/firestore/indexes?create_composite=${enc2}`);
          }
        }
        // 当てはまる文書
        const pre = this._coll ? this._coll + '/' : null;
        let rows = Object.entries(d.docs).filter(([k]) => {
          const parts = k.split('/');
          if (o.group) return parts[parts.length - 2] === o.group;
          return k.startsWith(pre) && k.slice(pre.length).split('/').length === 1;
        }).map(([k, rec]) => ({ k, rec }));
        const val = (rec, f) => (f === '__name__' ? rec.k : getPath(rec.rec.f, f));
        rows = rows.filter((r) => o.wh.every(([f, op, v0]) => {
          const x = val(r, f);
          const v = enc(v0, w);
          if (x === undefined && op !== '!=' && op !== 'not-in') return false;
          switch (op) {
            case '==': return cmpVal(x, v) === 0 && typeRank(x) === typeRank(v);
            case '!=': return x !== undefined && x !== null && cmpVal(x, v) !== 0;
            case '<': return typeRank(x) === typeRank(v) && cmpVal(x, v) < 0;
            case '<=': return typeRank(x) === typeRank(v) && cmpVal(x, v) <= 0;
            case '>': return typeRank(x) === typeRank(v) && cmpVal(x, v) > 0;
            case '>=': return typeRank(x) === typeRank(v) && cmpVal(x, v) >= 0;
            case 'array-contains': return Array.isArray(x) && x.some((y) => cmpVal(y, v) === 0);
            case 'array-contains-any': return Array.isArray(x) && x.some((y) => v.some((z) => cmpVal(y, z) === 0));
            case 'in': return v.some((z) => cmpVal(x, z) === 0);
            case 'not-in': return x !== undefined && !v.some((z) => cmpVal(x, z) === 0);
          }
          return false;
        }));
        // orderBy した項目がない文書は、結果に出ない
        rows = rows.filter((r) => order.every(([f]) => val(r, f) !== undefined));
        rows.sort((a, b) => { for (const [f, dir] of order) { const c0 = cmpVal(val(a, f), val(b, f)); if (c0) return dir === 'DESCENDING' ? -c0 : c0; } const last = order.length && order[order.length - 1][1] === 'DESCENDING' ? -1 : 1; return last * (a.k < b.k ? -1 : a.k > b.k ? 1 : 0); });
        if (o.startAfter) { const sv = o.startAfter.map((x) => (x instanceof DocSnap ? null : enc(x, w))); rows = rows.filter((r) => { for (let j = 0; j < order.length && j < sv.length; j++) { const c0 = cmpVal(val(r, order[j][0]), sv[j]); if (c0) return order[j][1] === 'DESCENDING' ? c0 < 0 : c0 > 0; } return false; }); }
        rows = rows.slice(o.off);
        if (o.lim !== null) rows = rows.slice(0, o.lim);
        const docs = rows.map((r) => new DocSnap(new DocRef(this.firestore, r.k), o.sel ? { f: Object.fromEntries(o.sel.map((f) => [f, getPath(r.rec.f, f)]).filter(([, v]) => v !== undefined)), c: r.rec.c, u: r.rec.u } : r.rec));
        return { docs, size: docs.length, empty: !docs.length, forEach: (fn) => docs.forEach(fn), readTime: Timestamp.fromMillis(G.T0 + w.t) };
      }
    }
    class CollRef extends Query {
      constructor(db, path) {
        if (path.split('/').filter(Boolean).length % 2 === 0) throw new Error(`Value for argument "collectionPath" must point to a collection, but was "${path}". Your path does not contain an odd number of components.`);
        super(db, path.replace(/^\/|\/$/g, ''));
        this.path = this._coll; this.id = this.path.split('/').pop();
      }
      doc(id) { return new DocRef(this.firestore, this.path + '/' + (id === undefined ? autoId(w) : id)); }
      async add(data) { const ref = this.doc(); await ref.create(data); return ref; }
      async listDocuments() { const d = this.firestore._db('datastore.entities.list'); return Object.keys(d.docs).filter((k) => k.startsWith(this.path + '/') && k.split('/').length === this.path.split('/').length + 1).map((k) => new DocRef(this.firestore, k)); }
    }
    class Batch {
      constructor(db) { this.db = db; this.ops = []; }
      set(ref, data, o) { this.ops.push(() => ref.set(data, o)); return this; }
      create(ref, data) { this.ops.push(() => ref.create(data)); return this; }
      update(ref, data) { this.ops.push(() => ref.update(data)); return this; }
      delete(ref) { this.ops.push(() => ref.delete()); return this; }
      async commit() {
        const d = this.db._db('datastore.entities.update');
        const snap = G.clone(d.docs);
        try { for (const op of this.ops) await op(); } catch (e) { d.docs = snap; throw e; }
        return this.ops.map(() => ({ writeTime: Timestamp.fromMillis(G.T0 + w.t) }));
      }
    }
    class Txn extends Batch {
      constructor(db) { super(db); }
      async get(ref) { if (this.ops.length) throw new Error('Firestore transactions require all reads to be executed before all writes.'); return ref.get ? ref.get() : ref; }
      _commit() { return this.commit(); }
    }
    const Filter = { where: (f, op, v) => ({ __filter: true, list: [[f, op, v]] }), and: (...fs) => ({ __filter: true, list: fs.flatMap((x) => x.list) }) };
    return { Firestore, FieldValue: FV, Timestamp, Filter };
  };
})(typeof window !== 'undefined' ? window : globalThis);
