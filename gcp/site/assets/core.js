// 小さな GCP の中心：世界の状態（JSON だけ。clone は structuredClone）、ID と時刻、リソースの階層、IAM、API 呼び出しの記録。
// 読み込み順は src/lib/gcp-files.mjs。どのファイルも window.GCP（Node では globalThis.GCP）に部品を足す。
//
// ■ 世界（world）… すべて JSON。関数や Map は入れない（clone と保存のため）
//   world.t          仮想時刻（ミリ秒、2026-11-16T09:00:00Z から）
//   world.org        組織   world.folders / world.projects / world.billing（請求先アカウント）
//   world.people     Google アカウント（個人・組織）  world.groups  グループ
//   world.policies   { リソース名: { bindings:[{role, members:[…], condition?}], etag, version } }
//   world.svc        サービスごとの状態（storage、compute、run、pubsub、firestore、sql、bq、logging …）
//
// ■ API を呼ぶ（各サービスの gcloud / bq / SDK はここを通す）
//   GCP.api(ctx, { svc, method, perm, res, verb, url, body, audit })
//     → サービス（API）が有効か、請求先が要るか、IAM の権限があるかを調べ、だめなら GCP.Err を投げる。
//       --log-http なら要求を表示し、書き換える操作は監査ログ（Admin Activity）に残す
(function (root) {
  'use strict';
  const G = root.GCP = root.GCP || {};

  // ---------------------------------------------------------------- 小道具
  const T0 = Date.UTC(2026, 10, 16, 9, 0, 0);
  G.T0 = T0;
  G.iso = (t, ms = 3) => { const s = new Date(T0 + t).toISOString(); return ms === 3 ? s : ms === 0 ? s.replace(/\.\d+Z$/, 'Z') : s.replace(/(\.\d{3})Z$/, '$1' + '0'.repeat(ms - 3) + 'Z'); };
  // 文字列から決まった数（毎回同じ結果にするため、乱数は使わない）
  G.hash = (s) => { let h = 2166136261 >>> 0; for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; };
  G.digits = (s, n) => { let out = '', k = 0; while (out.length < n) out += String(G.hash(s + ':' + k++)).padStart(10, '0'); out = out.slice(0, n); return out[0] === '0' ? '1' + out.slice(1) : out; };
  G.hex = (s, n) => { let out = '', k = 0; while (out.length < n) out += G.hash(s + '#' + k++).toString(16).padStart(8, '0'); return out.slice(0, n); };
  G.alnum = (s, n) => { const A = 'abcdefghijklmnopqrstuvwxyz0123456789'; let out = '', k = 0; while (out.length < n) out += A[G.hash(s + '!' + k++) % 36]; return out; };
  // world の中の通し番号（同じ操作の列なら同じ番号になる）
  G.seq = (w, k) => (w.seq[k] = (w.seq[k] || 0) + 1);
  G.tick = (w, ms) => { w.t += ms; };
  G.clone = (w) => (typeof structuredClone === 'function' ? structuredClone(w) : JSON.parse(JSON.stringify(w)));
  G.basename = (s) => String(s).split('/').pop();

  // ---------------------------------------------------------------- エラー
  // gcloud の表示：ERROR: (gcloud.xxx.yyy) 本文。code は HTTP の状態、status は gRPC の名前
  class Err extends Error {
    constructor(code, status, message, extra) { super(message); this.code = code; this.status = status; Object.assign(this, extra || {}); }
  }
  G.Err = Err;
  G.E = {
    denied: (msg, extra) => new Err(403, 'PERMISSION_DENIED', msg, extra),
    notFound: (msg, extra) => new Err(404, 'NOT_FOUND', msg, extra),
    exists: (msg, extra) => new Err(409, 'ALREADY_EXISTS', msg, extra),
    bad: (msg, extra) => new Err(400, 'INVALID_ARGUMENT', msg, extra),
    precond: (msg, extra) => new Err(400, 'FAILED_PRECONDITION', msg, extra),
    usage: (msg) => new Err(0, 'USAGE', msg),          // コマンドの書き方の誤り（終了ステータス 2）
    plain: (msg) => new Err(0, 'PLAIN', msg),          // そのまま表示して終了ステータス 1
  };

  // ---------------------------------------------------------------- 最初の世界
  const ORG_ID = '405918273641';
  const BILL = '01A2B3-C4D5E6-F7A8B9';
  G.DOMAIN = 'tsubame.example';
  G.ORG_ID = ORG_ID;
  G.BILLING_ID = BILL;

  function newWorld() {
    const w = {
      t: 0, seq: {},
      org: { id: ORG_ID, domain: G.DOMAIN, displayName: G.DOMAIN, directoryCustomerId: 'C03k8x2pq', createTime: '2024-04-01T02:13:45.120Z' },
      folders: {},
      projects: {},
      billing: {
        [BILL]: { id: BILL, displayName: 'つばめ文具 請求先', open: true, masterBillingAccount: '', currencyCode: 'JPY', budgets: [] },
      },
      // 人（Google アカウント）。kind：managed（組織のドメインの、管理されたアカウント）/ consumer（個人の Google アカウント）
      people: {
        'you@tsubame.example': { kind: 'managed', name: '小林 遥', title: '情報システム担当（このサイトの読者）' },
        'alice@tsubame.example': { kind: 'managed', name: '青木 亜里沙', title: 'アプリ開発' },
        'bob@tsubame.example': { kind: 'managed', name: '馬場 文彦', title: '売上分析' },
        'admin@tsubame.example': { kind: 'managed', name: '管理者', title: 'Workspace の特権管理者' },
        'taro@example.com': { kind: 'consumer', name: '外部の協力者', title: '個人の Google アカウント（組織の外）' },
      },
      groups: {
        'dev-team@tsubame.example': { displayName: '開発チーム', members: ['alice@tsubame.example', 'you@tsubame.example'] },
        'analysts@tsubame.example': { displayName: '分析チーム', members: ['bob@tsubame.example'] },
      },
      // 組織の IAM。you は組織の管理を任されている（フォルダとプロジェクトを作れる）
      policies: {
        ['organizations/' + ORG_ID]: { version: 1, etag: 'BwYk3QaA1nE=', bindings: [
          { role: 'roles/billing.user', members: ['user:you@tsubame.example'] },
          { role: 'roles/resourcemanager.folderAdmin', members: ['user:you@tsubame.example'] },
          { role: 'roles/resourcemanager.organizationAdmin', members: ['user:admin@tsubame.example', 'user:you@tsubame.example'] },
          { role: 'roles/resourcemanager.projectCreator', members: ['domain:tsubame.example'] },
        ] },
        ['billingAccounts/' + BILL]: { version: 1, etag: 'BwYk3QaB2xQ=', bindings: [
          { role: 'roles/billing.admin', members: ['user:admin@tsubame.example'] },
          { role: 'roles/billing.user', members: ['user:you@tsubame.example'] },
          { role: 'roles/billing.costsManager', members: ['user:you@tsubame.example'] },
        ] },
      },
      orgPolicies: {},
      svc: {},
      logs: [],
      // 端末（Cloud Shell）の gcloud の設定
      cfg: { active: 'default', configurations: { default: { core: { account: 'you@tsubame.example', disable_usage_reporting: 'True' } } } },
      tokens: {},
    };
    for (const k of Object.keys(G.SERVICES_INIT || {})) w.svc[k] = G.SERVICES_INIT[k]();
    return w;
  }
  G.newWorld = newWorld;
  G.SERVICES_INIT = G.SERVICES_INIT || {};

  // ---------------------------------------------------------------- API（サービス）の一覧
  // name → 表示名。新しいプロジェクトで最初から有効なもの（DEFAULT_ON）は、本物の新しいプロジェクトに近いもの
  G.APIS = {
    'bigquery.googleapis.com': 'BigQuery API',
    'bigquerystorage.googleapis.com': 'BigQuery Storage API',
    'billingbudgets.googleapis.com': 'Cloud Billing Budget API',
    'cloudbilling.googleapis.com': 'Cloud Billing API',
    'cloudbuild.googleapis.com': 'Cloud Build API',
    'cloudfunctions.googleapis.com': 'Cloud Functions API',
    'cloudresourcemanager.googleapis.com': 'Cloud Resource Manager API',
    'compute.googleapis.com': 'Compute Engine API',
    'artifactregistry.googleapis.com': 'Artifact Registry API',
    'datastore.googleapis.com': 'Cloud Datastore API',
    'firestore.googleapis.com': 'Cloud Firestore API',
    'iam.googleapis.com': 'Identity and Access Management (IAM) API',
    'iamcredentials.googleapis.com': 'IAM Service Account Credentials API',
    'logging.googleapis.com': 'Cloud Logging API',
    'monitoring.googleapis.com': 'Cloud Monitoring API',
    'orgpolicy.googleapis.com': 'Organization Policy API',
    'oslogin.googleapis.com': 'Cloud OS Login API',
    'pubsub.googleapis.com': 'Cloud Pub/Sub API',
    'run.googleapis.com': 'Cloud Run Admin API',
    'serviceusage.googleapis.com': 'Service Usage API',
    'sqladmin.googleapis.com': 'Cloud SQL Admin API',
    'sql-component.googleapis.com': 'Cloud SQL',
    'storage.googleapis.com': 'Cloud Storage API',
    'eventarc.googleapis.com': 'Eventarc API',
  };
  G.DEFAULT_ON = ['bigquery.googleapis.com', 'bigquerystorage.googleapis.com', 'cloudresourcemanager.googleapis.com', 'datastore.googleapis.com', 'logging.googleapis.com', 'monitoring.googleapis.com', 'serviceusage.googleapis.com', 'sql-component.googleapis.com', 'storage.googleapis.com'];
  // 有効にするとき、いっしょに有効になるもの
  G.API_DEPS = {
    'run.googleapis.com': ['iam.googleapis.com', 'iamcredentials.googleapis.com'],
    'cloudfunctions.googleapis.com': ['run.googleapis.com', 'cloudbuild.googleapis.com', 'artifactregistry.googleapis.com', 'iam.googleapis.com', 'iamcredentials.googleapis.com', 'eventarc.googleapis.com', 'pubsub.googleapis.com'],
    'cloudbuild.googleapis.com': ['artifactregistry.googleapis.com', 'pubsub.googleapis.com'],
    'compute.googleapis.com': ['oslogin.googleapis.com'],
    'firestore.googleapis.com': ['datastore.googleapis.com'],
    'sqladmin.googleapis.com': [],
  };
  // 請求先がないと使えない API
  G.NEEDS_BILLING = new Set(['compute.googleapis.com', 'run.googleapis.com', 'cloudfunctions.googleapis.com', 'cloudbuild.googleapis.com', 'artifactregistry.googleapis.com', 'sqladmin.googleapis.com', 'pubsub.googleapis.com', 'firestore.googleapis.com']);

  // ---------------------------------------------------------------- プロジェクト
  G.projectNumber = (id) => G.digits('project:' + id, 12);
  function makeProject(w, id, o = {}) {
    const p = {
      projectId: id, name: o.name || id, projectNumber: G.projectNumber(id),
      parent: 'parent' in o ? o.parent : { type: 'organization', id: ORG_ID },
      lifecycleState: 'ACTIVE', createTime: G.iso(w.t), labels: o.labels || {},
      billing: o.billing || '', services: G.DEFAULT_ON.slice(), deleteTime: '',
    };
    w.projects[id] = p;
    const num = p.projectNumber;
    // 作った人が owner になる
    w.policies['projects/' + id] = { version: 1, etag: 'BwY' + G.alnum('etag' + id, 9) + '=', bindings: [{ role: 'roles/owner', members: ['user:' + (o.creator || 'you@tsubame.example')] }] };
    if (o.defaultSa !== false) addServiceAgents(w, id);
    return p;
  }
  G.makeProject = makeProject;
  // API を有効にしたときに現れるサービスアカウント（既定のサービスアカウントとサービス エージェント）
  function addServiceAgents(w, id) {}
  G.addServiceAgents = addServiceAgents;

  // ---------------------------------------------------------------- リソースの階層
  // リソース名の親をたどる。'projects/x/buckets/y' のような名前は「その場で作る名前」で、IAM の継承に使う
  G.parentOf = (w, name) => {
    if (name.startsWith('projects/')) {
      const parts = name.split('/');
      if (parts.length > 2) {
        // projects/p/xxx/yyy/zzz/www → projects/p/xxx/yyy（2 つずつ短くする）
        return parts.slice(0, parts.length - 2).join('/');
      }
      const p = w.projects[parts[1]];
      if (!p || !p.parent) return null;
      return p.parent.type === 'folder' ? 'folders/' + p.parent.id : 'organizations/' + p.parent.id;
    }
    if (name.startsWith('folders/')) {
      const f = w.folders[name.split('/')[1]];
      if (!f) return null;
      return f.parent;
    }
    return null;
  };
  G.ancestry = (w, name) => { const out = []; let n = name; while (n) { out.push(n); n = G.parentOf(w, n); } return out; };

  // ---------------------------------------------------------------- IAM：ロールと権限
  // 権限の名前は「サービス.リソース.動詞」。基本ロールは動詞で決める（本物は数千の権限の一覧）
  const VIEW_VERBS = /\.(get|list|getIamPolicy|getMetadata|search|read|getData|export_never)$/;
  const roles = {};
  G.ROLES = roles;
  function role(name, title, perms, desc, stage) { roles[name] = { name, title, perms, description: desc || title, stage: stage || 'GA' }; }
  // 基本ロール
  role('roles/viewer', 'Viewer', (p) => VIEW_VERBS.test(p) && !/^(iam\.serviceAccountKeys|secretmanager\.versions\.access|storage\.objects\.get$)/.test(p) || p === 'storage.objects.get' || p === 'resourcemanager.projects.get' || p === 'bigquery.tables.getData',
    '読み取り専用の操作の権限（既存のリソースやデータの表示など）。変更はできません');
  role('roles/editor', 'Editor', (p) => !/^iam\.serviceAccounts\.(getAccessToken|getOpenIdToken|signBlob|signJwt|implicitDelegation)$/.test(p) && !/(setIamPolicy|\.roles\.(create|update|delete)|resourcemanager\.projects\.(delete|move)|billing\.)/.test(p) && !/^iam\.serviceAccounts\.(actAs_x)$/.test(p),
    'Viewer の権限に加えて、状態を変える操作の権限（既存のリソースの変更など）');
  role('roles/owner', 'Owner', (p) => !/^iam\.serviceAccounts\.(getAccessToken|getOpenIdToken|signBlob|signJwt|implicitDelegation)$/.test(p), 'Editor の権限に加えて、権限とロールの管理、請求の設定');
  role('roles/browser', 'Browser', ['resourcemanager.organizations.get', 'resourcemanager.folders.get', 'resourcemanager.folders.list', 'resourcemanager.projects.get', 'resourcemanager.projects.list', 'resourcemanager.projects.getIamPolicy_x'],
    'フォルダ、組織、IAM ポリシーを含むプロジェクトの階層を閲覧するアクセス権。プロジェクト内のリソースの閲覧は含みません');
  // 組織・フォルダ・プロジェクト
  role('roles/resourcemanager.organizationAdmin', 'Organization Administrator', (p) => /^resourcemanager\./.test(p) || /^orgpolicy\.policies\.(get|list)$/.test(p), '組織のすべてのリソースの IAM ポリシーを管理する権限');
  role('roles/resourcemanager.folderAdmin', 'Folder Admin', (p) => /^resourcemanager\.(folders|projects)\./.test(p) && p !== 'resourcemanager.projects.create', 'フォルダに対するすべての権限');
  role('roles/resourcemanager.projectCreator', 'Project Creator', ['resourcemanager.projects.create', 'resourcemanager.organizations.get', 'resourcemanager.folders.list'], '新しいプロジェクトを作成するアクセス権');
  role('roles/orgpolicy.policyAdmin', 'Organization Policy Administrator', (p) => /^orgpolicy\./.test(p), '組織のポリシーを管理する権限');
  // 請求
  role('roles/billing.admin', 'Billing Account Administrator', (p) => /^billing\./.test(p), '請求先アカウントのすべての操作');
  role('roles/billing.user', 'Billing Account User', ['billing.accounts.get', 'billing.accounts.list', 'billing.resourceAssociations.create', 'billing.accounts.getIamPolicy', 'billing.accounts.redeemPromotion', 'billing.credits.list'], '請求先アカウントをプロジェクトに関連付ける権限');
  role('roles/billing.costsManager', 'Billing Account Costs Manager', ['billing.accounts.get', 'billing.budgets.create', 'billing.budgets.get', 'billing.budgets.list', 'billing.budgets.update', 'billing.budgets.delete'], '予算の管理と費用の閲覧');
  role('roles/billing.viewer', 'Billing Account Viewer', ['billing.accounts.get', 'billing.budgets.get', 'billing.budgets.list'], '請求先アカウントの情報を見る権限');
  role('roles/billing.projectManager', 'Project Billing Manager', ['resourcemanager.projects.createBillingAssignment', 'resourcemanager.projects.deleteBillingAssignment'], 'プロジェクトの請求先の関連付けを変える権限');
  // IAM・サービスアカウント
  role('roles/iam.serviceAccountUser', 'Service Account User', ['iam.serviceAccounts.actAs', 'iam.serviceAccounts.get', 'iam.serviceAccounts.list'], 'サービスアカウントとしてオペレーションを実行する権限（リソースに割り当てる）');
  role('roles/iam.serviceAccountTokenCreator', 'Service Account Token Creator', ['iam.serviceAccounts.getAccessToken', 'iam.serviceAccounts.getOpenIdToken', 'iam.serviceAccounts.signBlob', 'iam.serviceAccounts.get'], 'サービスアカウントの権限を借りる（トークンを作る）権限');
  role('roles/iam.serviceAccountAdmin', 'Service Account Admin', (p) => /^iam\.serviceAccounts\./.test(p) && !/getAccessToken|getOpenIdToken|actAs/.test(p), 'サービスアカウントの作成と管理');
  role('roles/iam.roleViewer', 'Role Viewer', ['iam.roles.get', 'iam.roles.list'], 'ロールの閲覧');
  role('roles/iam.securityReviewer', 'Security Reviewer', (p) => /\.(getIamPolicy|list)$/.test(p), 'すべての IAM ポリシーを閲覧する権限');
  // Cloud Storage
  role('roles/storage.admin', 'Storage Admin', (p) => /^storage\./.test(p), 'バケットとオブジェクトの完全な管理');
  role('roles/storage.objectAdmin', 'Storage Object Admin', (p) => /^storage\.objects\./.test(p) || p === 'storage.buckets.get' || p === 'storage.buckets.list', 'オブジェクトの完全な管理');
  role('roles/storage.objectUser', 'Storage Object User', (p) => /^storage\.objects\.(get|list|create|delete|update)$/.test(p), 'オブジェクトの読み書き');
  role('roles/storage.objectViewer', 'Storage Object Viewer', ['storage.objects.get', 'storage.objects.list', 'storage.buckets.get_x'], 'オブジェクトとメタデータを閲覧する権限');
  role('roles/storage.objectCreator', 'Storage Object Creator', ['storage.objects.create'], 'オブジェクトを作成する権限（上書き、閲覧はできません）');
  role('roles/storage.legacyBucketOwner', 'Storage Legacy Bucket Owner', ['storage.buckets.get', 'storage.buckets.update', 'storage.buckets.getIamPolicy', 'storage.buckets.setIamPolicy', 'storage.objects.list', 'storage.objects.create', 'storage.objects.delete'], 'バケットの読み書きと IAM の変更（プロジェクトの owner と editor に付く）');
  role('roles/storage.legacyObjectOwner', 'Storage Legacy Object Owner', ['storage.objects.get', 'storage.objects.update', 'storage.objects.getIamPolicy', 'storage.objects.setIamPolicy'], 'オブジェクトの読み書き');
  role('roles/storage.legacyObjectReader', 'Storage Legacy Object Reader', ['storage.objects.get'], 'オブジェクトの読み取り');
  role('roles/storage.legacyBucketReader', 'Storage Legacy Bucket Reader', ['storage.buckets.get', 'storage.objects.list'], 'バケットの中身の一覧');
  // Compute Engine
  role('roles/compute.admin', 'Compute Admin', (p) => /^compute\./.test(p), 'Compute Engine のすべてのリソース');
  role('roles/compute.instanceAdmin.v1', 'Compute Instance Admin (v1)', (p) => /^compute\.(instances|disks|images|zones|regions|machineTypes|subnetworks\.use|networks\.use|addresses\.use)/.test(p) || /^compute\.\w+\.(get|list)$/.test(p), 'インスタンスの作成・変更・削除');
  role('roles/compute.networkAdmin', 'Compute Network Admin', (p) => /^compute\.(networks|subnetworks|addresses|routes|routers)\./.test(p) || /^compute\.\w+\.(get|list)$/.test(p), 'ネットワークの作成・変更・削除（ファイアウォールのルールは除く）');
  role('roles/compute.securityAdmin', 'Compute Security Admin', (p) => /^compute\.firewalls\./.test(p) || /^compute\.\w+\.(get|list)$/.test(p), 'ファイアウォールのルールの作成・変更・削除');
  role('roles/compute.viewer', 'Compute Viewer', (p) => /^compute\.\w+\.(get|list)$/.test(p), 'Compute Engine のリソースの読み取り');
  role('roles/compute.osLogin', 'Compute OS Login', ['compute.instances.osLogin', 'compute.instances.get', 'compute.instances.list'], 'VM に一般ユーザーとしてログインする');
  // Cloud Run・Functions・Build・Artifact Registry
  role('roles/run.admin', 'Cloud Run Admin', (p) => /^run\./.test(p), 'Cloud Run のすべてのリソースの完全な管理');
  role('roles/run.developer', 'Cloud Run Developer', (p) => /^run\./.test(p) && !/IamPolicy/.test(p), 'Cloud Run のリソースの読み書き（IAM の変更は除く）');
  role('roles/run.invoker', 'Cloud Run Invoker', ['run.routes.invoke', 'run.jobs.run'], 'Cloud Run のサービスを呼び出す権限');
  role('roles/run.viewer', 'Cloud Run Viewer', (p) => /^run\.\w+\.(get|list|getIamPolicy)$/.test(p), 'Cloud Run のリソースの閲覧');
  role('roles/cloudfunctions.developer', 'Cloud Functions Developer', (p) => /^cloudfunctions\./.test(p) && !/IamPolicy/.test(p), '関数の作成と更新');
  role('roles/cloudbuild.builds.editor', 'Cloud Build Editor', (p) => /^cloudbuild\.builds\./.test(p), 'ビルドの作成と取り消し');
  role('roles/artifactregistry.reader', 'Artifact Registry Reader', (p) => /^artifactregistry\.\w+\.(get|list|download)/.test(p), 'イメージの読み取り');
  role('roles/artifactregistry.writer', 'Artifact Registry Writer', (p) => /^artifactregistry\.\w+\.(get|list|download|upload|create|update)/.test(p), 'イメージの読み書き');
  // Pub/Sub
  role('roles/pubsub.admin', 'Pub/Sub Admin', (p) => /^pubsub\./.test(p), 'トピックとサブスクリプションの完全な管理');
  role('roles/pubsub.editor', 'Pub/Sub Editor', (p) => /^pubsub\./.test(p) && !/IamPolicy/.test(p), 'トピックとサブスクリプションの作成・変更・メッセージの送受信');
  role('roles/pubsub.publisher', 'Pub/Sub Publisher', ['pubsub.topics.publish'], 'トピックにメッセージを送る権限');
  role('roles/pubsub.subscriber', 'Pub/Sub Subscriber', ['pubsub.subscriptions.consume', 'pubsub.topics.attachSubscription'], 'サブスクリプションからメッセージを受け取る権限');
  role('roles/pubsub.viewer', 'Pub/Sub Viewer', (p) => /^pubsub\.\w+\.(get|list)$/.test(p), 'トピックとサブスクリプションの閲覧');
  // Firestore（Datastore）
  role('roles/datastore.owner', 'Cloud Datastore Owner', (p) => /^datastore\./.test(p), 'データベースとデータの完全な管理');
  role('roles/datastore.user', 'Cloud Datastore User', (p) => /^datastore\.(entities|indexes\.list|databases\.get|namespaces|statistics)/.test(p), 'データの読み書き');
  role('roles/datastore.viewer', 'Cloud Datastore Viewer', (p) => /^datastore\.\w+\.(get|list)$/.test(p), 'データの読み取り');
  // Cloud SQL
  role('roles/cloudsql.admin', 'Cloud SQL Admin', (p) => /^cloudsql\./.test(p), 'Cloud SQL のすべてのリソース');
  role('roles/cloudsql.editor', 'Cloud SQL Editor', (p) => /^cloudsql\./.test(p) && !/(instances\.(create|delete)|users\.|IamPolicy)/.test(p), 'インスタンスの管理（作成と削除は除く）');
  role('roles/cloudsql.client', 'Cloud SQL Client', ['cloudsql.instances.connect', 'cloudsql.instances.get'], 'Cloud SQL Auth Proxy などからインスタンスに接続する権限');
  role('roles/cloudsql.viewer', 'Cloud SQL Viewer', (p) => /^cloudsql\.\w+\.(get|list)$/.test(p), 'Cloud SQL のリソースの閲覧');
  // BigQuery
  role('roles/bigquery.admin', 'BigQuery Admin', (p) => /^bigquery\./.test(p), 'BigQuery のすべてのリソースの管理');
  role('roles/bigquery.dataEditor', 'BigQuery Data Editor', (p) => /^bigquery\.(tables|datasets\.get|routines|models)/.test(p), 'データセットの中身（テーブル）の読み書き');
  role('roles/bigquery.dataViewer', 'BigQuery Data Viewer', (p) => /^bigquery\.(tables\.(get|list|getData)|datasets\.get|routines\.(get|list))$/.test(p), 'テーブルのデータとメタデータの読み取り');
  role('roles/bigquery.jobUser', 'BigQuery Job User', ['bigquery.jobs.create'], 'クエリを含むジョブを実行する権限');
  role('roles/bigquery.user', 'BigQuery User', ['bigquery.jobs.create', 'bigquery.datasets.create', 'bigquery.datasets.get_x', 'bigquery.jobs.list'], 'ジョブの実行と、データセットの作成');
  // Logging・Monitoring
  role('roles/logging.viewer', 'Logs Viewer', ['logging.logEntries.list', 'logging.logs.list', 'logging.sinks.get', 'logging.sinks.list', 'logging.logMetrics.get', 'logging.logMetrics.list'], 'ログの閲覧（データアクセスの監査ログは除く）');
  role('roles/logging.logWriter', 'Logs Writer', ['logging.logEntries.create'], 'ログを書き込む権限');
  role('roles/logging.admin', 'Logging Admin', (p) => /^logging\./.test(p), 'ログの完全な管理');
  role('roles/logging.privateLogViewer', 'Private Logs Viewer', ['logging.logEntries.list', 'logging.privateLogEntries.list'], 'データアクセスの監査ログを含むログの閲覧');
  role('roles/monitoring.viewer', 'Monitoring Viewer', (p) => /^monitoring\.\w+\.(get|list)$/.test(p), 'Monitoring のデータの閲覧');
  role('roles/monitoring.metricWriter', 'Monitoring Metric Writer', ['monitoring.timeSeries.create'], '指標を書き込む権限');
  role('roles/monitoring.editor', 'Monitoring Editor', (p) => /^monitoring\./.test(p), 'Monitoring の設定の変更');
  role('roles/serviceusage.serviceUsageAdmin', 'Service Usage Admin', (p) => /^serviceusage\./.test(p), 'API の有効化と無効化');
  role('roles/serviceusage.serviceUsageConsumer', 'Service Usage Consumer', ['serviceusage.services.use', 'serviceusage.services.get', 'serviceusage.services.list'], 'API を使う権限');
  // サービスエージェント（Google が管理するサービスアカウントに付くもの）
  role('roles/run.serviceAgent', 'Cloud Run Service Agent', (p) => /^(run|artifactregistry)\./.test(p) || p === 'iam.serviceAccounts.actAs', 'Cloud Run のサービスエージェント', 'GA');
  role('roles/pubsub.serviceAgent', 'Cloud Pub/Sub Service Agent', ['iam.serviceAccounts.getOpenIdToken', 'iam.serviceAccounts.getAccessToken'], 'Pub/Sub のサービスエージェント');
  role('roles/cloudbuild.builds.builder', 'Cloud Build Service Account', (p) => /^(artifactregistry|storage|logging\.logEntries\.create|cloudbuild)/.test(p), 'ビルドを実行するサービスアカウントの権限');
  role('roles/compute.serviceAgent', 'Compute Engine Service Agent', (p) => /^compute\./.test(p), 'Compute Engine のサービスエージェント');

  G.roleHas = (w, roleName, perm) => {
    const r = roles[roleName] || (w.customRoles && w.customRoles[roleName]);
    if (!r) return false;
    const ps = r.perms || r.includedPermissions;
    return typeof ps === 'function' ? !!ps(perm) : ps.includes(perm);
  };
  // 権限の一覧（describe 用）。関数で決めるロールは、知っている権限の中から集める
  G.KNOWN_PERMS = [];
  G.permsOf = (w, roleName) => {
    const r = roles[roleName] || (w.customRoles && w.customRoles[roleName]);
    if (!r) return [];
    const ps = r.perms || r.includedPermissions;
    if (typeof ps !== 'function') return ps.filter((p) => !/_x$/.test(p)).slice().sort();
    // 関数で決めるロールは、このサイトが知っている権限（ロールの一覧に書いたものと、API の呼び出しで使ったもの）の中から集める
    const all = new Set(G.KNOWN);
    for (const r2 of Object.values(roles)) if (Array.isArray(r2.perms)) for (const x of r2.perms) if (!/_x$/.test(x)) all.add(x);
    return [...all].filter((p) => ps(p)).sort();
  };

  // ---------------------------------------------------------------- IAM：だれがだれか
  // プリンシパルの文字列：user:… / group:… / serviceAccount:… / domain:… / allUsers / allAuthenticatedUsers
  G.principalKind = (w, email) => {
    if (!email) return 'anonymous';
    if (/\.gserviceaccount\.com$/.test(email)) return 'serviceAccount';
    if (w.groups[email]) return 'group';
    return 'user';
  };
  // email（だれ）が member（ポリシーの書き方）に当たるか
  function matches(w, email, member) {
    if (member === 'allUsers') return true;
    if (!email) return false;
    if (member === 'allAuthenticatedUsers') return true;
    const [k, v] = member.split(/:(.*)/s);
    if (k === 'user' || k === 'serviceAccount') return v === email;
    if (k === 'group') { const g = w.groups[v]; return !!g && (g.members.includes(email) || g.members.some((m) => w.groups[m] && w.groups[m].members.includes(email))); }
    if (k === 'domain') return email.endsWith('@' + v) && G.principalKind(w, email) !== 'serviceAccount';
    if (k === 'projectOwner' || k === 'projectEditor' || k === 'projectViewer') {
      const role = 'roles/' + k.slice(7).toLowerCase();
      const pol = w.policies['projects/' + v];
      return !!pol && pol.bindings.some((b) => b.role === role && b.members.some((m) => matches(w, email, m)));
    }
    return false;
  }
  G.matches = matches;
  // 条件（IAM Conditions）は、時刻の比較とリソース名の接頭辞だけ
  function condOk(w, cond, resName) {
    if (!cond || !cond.expression) return true;
    const e = cond.expression;
    let m;
    if ((m = e.match(/request\.time\s*<\s*timestamp\(["']([^"']+)["']\)/))) return G.T0 + w.t < Date.parse(m[1]);
    if ((m = e.match(/resource\.name\.startsWith\(["']([^"']+)["']\)/))) return resName.startsWith(m[1]);
    return true;
  }
  // 権限があるか。理由（どこのどのロールで）も返す
  G.check = (w, email, perm, resName) => {
    for (const n of G.ancestry(w, resName)) {
      const pol = w.policies[n];
      if (!pol) continue;
      for (const b of pol.bindings) {
        if (!G.roleHas(w, b.role, perm)) continue;
        const m = b.members.find((x) => matches(w, email, x));
        if (m && condOk(w, b.condition, resName)) {
          // 拒否ポリシー
          const deny = (w.denyPolicies || []).find((d) => G.ancestry(w, resName).includes(d.attachment) && d.perms.includes(perm) && d.principals.some((x) => matches(w, email, x)));
          if (deny) return { ok: false, deny };
          return { ok: true, at: n, role: b.role, member: m };
        }
      }
    }
    return { ok: false };
  };

  // ---------------------------------------------------------------- サービスアカウント
  G.saEmail = (name, project) => `${name}@${project}.iam.gserviceaccount.com`;
  G.computeSa = (w, project) => `${w.projects[project].projectNumber}-compute@developer.gserviceaccount.com`;
  G.findSa = (w, email) => {
    for (const p of Object.values(w.projects)) {
      const s = (p.sas || {})[email];
      if (s) return { sa: s, project: p.projectId };
    }
    return null;
  };

  // ---------------------------------------------------------------- 監査ログ（Cloud Audit Logs）とふつうのログ
  // ログは world.logs に、Cloud Logging の LogEntry の形で積む
  G.log = (w, e) => {
    const n = G.seq(w, 'log');
    const entry = Object.assign({ insertId: G.alnum('log' + n, 12), timestamp: G.iso(w.t, 9), receiveTimestamp: G.iso(w.t + 7, 9), severity: 'DEFAULT' }, e);
    w.logs.push(entry);
    return entry;
  };
  G.audit = (w, o) => {
    if (!o.project) return;
    const p = w.projects[o.project];
    if (!p) return;
    const kind = o.read ? 'data_access' : 'activity';
    if (o.read && !o.forceData) return;   // データアクセスの監査ログは、既定では記録しない（BigQuery を除く）
    G.log(w, {
      logName: `projects/${o.project}/logs/cloudaudit.googleapis.com%2F${kind}`,
      resource: { type: o.resType || 'audited_resource', labels: Object.assign({ project_id: o.project }, o.resLabels || {}) },
      severity: o.denied ? 'ERROR' : 'NOTICE',
      protoPayload: {
        '@type': 'type.googleapis.com/google.cloud.audit.AuditLog',
        authenticationInfo: { principalEmail: o.who || '' },
        authorizationInfo: [{ granted: !o.denied, permission: o.perm, resource: o.res }],
        methodName: o.method,
        resourceName: o.resourceName || o.res,
        serviceName: o.svc,
        status: o.denied ? { code: 7, message: 'PERMISSION_DENIED' } : {},
      },
    });
  };

  // ---------------------------------------------------------------- API を呼ぶ
  // ctx = { w, who, project, logHttp, out(err/out), cmd }。svc は API の名前（xxx.googleapis.com）
  G.KNOWN = new Set();
  G.api = (ctx, o) => {
    const w = ctx.w;
    if (o.perm) G.KNOWN.add(o.perm);
    if (ctx.logHttp && o.url) {
      const body = o.body === undefined ? 'None' : JSON.stringify(o.body);
      ctx.err(`=======================\n==== request start ====\nuri: ${o.url}\nmethod: ${o.verb || 'GET'}\n== headers start ==\nb'authorization': --- Token Redacted ---\nb'content-type': b'application/json'\nb'user-agent': b'google-cloud-sdk gcloud/548.0.0 command/${ctx.cmd || 'gcloud'}'\n== headers end ==\n== body start ==\n${body}\n== body end ==\n==== request end ====\n`);
    }
    if (!ctx.who) throw new Err(401, 'UNAUTHENTICATED', 'You do not currently have an active account selected.', { gcloud: 'You do not currently have an active account selected.\nPlease run:\n\n  $ gcloud auth login\n\nto obtain new credentials.\n\nIf you have already logged in with a different account, run:\n\n  $ gcloud config set account ACCOUNT\n\nto select an already authenticated account to use.' });
    const proj = o.project !== undefined ? o.project : ctx.project;
    const p = proj ? w.projects[proj] : null;
    if (o.svc && p) {
      if (p.lifecycleState !== 'ACTIVE' && !o.allowDeleted) throw new Err(403, 'PERMISSION_DENIED', `Project '${proj}' has been deleted.`, { reason: 'USER_PROJECT_DENIED' });
      if (!p.services.includes(o.svc)) {
        const title = G.APIS[o.svc] || o.svc;
        throw new Err(403, 'PERMISSION_DENIED', `${title} has not been used in project ${p.projectNumber} before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/${o.svc}/overview?project=${p.projectNumber} then retry. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.`, { reason: 'SERVICE_DISABLED', service: o.svc, apiDisabled: true });
      }
    }
    // VM の中から：アクセススコープ（cloud-platform でなければ、API ごとに決まったスコープが要る）
    if (ctx.scopes && o.svc && !ctx.scopes.includes('cloud-platform')) {
      const write = !o.read;
      const need = o.svc === 'storage.googleapis.com' ? (write ? ['devstorage.read_write', 'devstorage.full_control'] : ['devstorage.read_only', 'devstorage.read_write', 'devstorage.full_control'])
        : o.svc === 'logging.googleapis.com' ? (write ? ['logging.write', 'logging.admin'] : ['logging.read', 'logging.admin'])
        : o.svc === 'pubsub.googleapis.com' ? ['pubsub'] : o.svc === 'bigquery.googleapis.com' ? ['bigquery'] : o.svc === 'compute.googleapis.com' ? (write ? ['compute'] : ['compute', 'compute.readonly']) : [];
      if (!ctx.scopes.some((s) => need.includes(s))) throw new Err(403, 'PERMISSION_DENIED', 'Request had insufficient authentication scopes.', { gcloud: o.svc === 'storage.googleapis.com' ? 'HTTPError 403: Provided scope(s) are not authorized' : 'PERMISSION_DENIED: Request had insufficient authentication scopes.' });
    }
    if (o.perm && o.res) {
      const r = G.check(w, ctx.who, o.perm, o.res);
      if (!r.ok) {
        if (!o.read) G.audit(w, { project: proj, who: ctx.who, method: o.method, perm: o.perm, res: o.res, svc: o.svc, denied: true, resType: o.resType });
        const msg = o.deniedMsg ? o.deniedMsg(ctx.who) : `Permission '${o.perm}' denied on resource '${o.resPretty || '//' + (o.svc || 'cloudresourcemanager.googleapis.com') + '/' + o.res}' (or it may not exist).`;
        throw new Err(403, 'PERMISSION_DENIED', msg, { perm: o.perm, res: o.res, deny: r.deny });
      }
    }
    if (o.svc && p && G.NEEDS_BILLING.has(o.svc) && o.billable && !p.billing) {
      throw new Err(403, 'FAILED_PRECONDITION', o.billMsg || `Billing account for project '${p.projectNumber}' is not found. Billing must be enabled for activation of service(s) '${o.svc}' to proceed.`, { reason: 'BILLING_DISABLED' });
    }
    if (o.audit !== false && o.method && !o.read) G.audit(w, { project: proj, who: ctx.who, method: o.method, perm: o.perm, res: o.res, svc: o.svc, resType: o.resType, resLabels: o.resLabels, resourceName: o.resourceName });
    if (o.read && o.dataAudit) G.audit(w, { project: proj, who: ctx.who, method: o.method, perm: o.perm, res: o.res, svc: o.svc, read: true, forceData: true, resType: o.resType });
    G.tick(w, o.ms || 40);
    return p;
  };
})(typeof window !== 'undefined' ? window : globalThis);
