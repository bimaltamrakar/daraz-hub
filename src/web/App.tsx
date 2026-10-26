import { FormEvent, ReactNode, useCallback, useEffect, useState } from "react";
import "./orders.css";

type User = { id: string; name: string; email: string; role: "admin" | "user"; mustChangePassword: boolean };
type Store = {
  id: string; label: string; country: string; status: string; createdAt: string;
  sellerId: string | null; sellerName: string | null; companyName: string | null; sellerEmail: string | null; shortCode: string | null;
  account: string | null; accountPlatform: string | null; darazCountry: string | null; darazUserId: string | null;
  sellerStatus: string | null; verified: boolean | null; location: string | null; connectedAt: string | null;
  profile: Record<string, unknown> | null; profileFetchedAt: string | null; profileError: string | null;
  accessExpiresAt: string | null; refreshExpiresAt: string | null; lastRefreshedAt: string | null; lastError: string | null;
  orderSyncFrom: string; orderSyncFrequency: string; orderSyncLastAt: string | null; orderSyncNextAt: string | null;
  orderSyncError: string | null; orderSyncRunning?: boolean;
  user?: { name: string; email: string };
};
type Activity = { id: string; action: string; createdAt: string; meta?: { phase?: string; reason?: string } | null };
type StoreDetails = Store & { activity: Activity[] };
type StoreTokens = { accessToken: string; refreshToken: string };
type Summary = { total: number; connected: number; expiringSoon: number; expired: number };
type Route = { page: "dashboard" | "stores" | "store" | "orders" | "admin" | "admin-store" | "audit"; storeId?: string };

const api = async (path: string, token?: string, init: RequestInit = {}) => {
  const response = await fetch(`/api${path}`, {
    ...init, credentials: "include",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
  if (response.status === 204) return null;
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed.");
  return body;
};
const dateLabel = (date: string | null) => date ? new Date(date).toLocaleString() : "Not connected";
const daysUntil = (date: string | null) => date ? Math.ceil((new Date(date).getTime() - Date.now()) / 86400000) : null;
const connectLabel = (store: Store) => store.status === "pending" || store.status === "error" ? "Connect store" : "Reconnect";

function routeFor(pathname: string): Route {
  const adminStore = pathname.match(/^\/admin\/stores\/([^/]+)/);
  if (adminStore) return { page: "admin-store", storeId: adminStore[1] };
  if (pathname.startsWith("/admin")) return { page: "admin" };
  if (pathname.startsWith("/audit")) return { page: "audit" };
  if (pathname.startsWith("/orders")) return { page: "orders" };
  const store = pathname.match(/^\/stores\/([^/]+)/);
  if (store) return { page: "store", storeId: store[1] };
  if (pathname.startsWith("/stores")) return { page: "stores" };
  return { page: "dashboard" };
}
const pathFor = (route: Route) =>
  route.page === "store" ? `/stores/${route.storeId}` : route.page === "admin-store" ? `/admin/stores/${route.storeId}` : route.page === "dashboard" ? "/" : `/${route.page}`;
const titleFor = (route: Route) =>
  ({ dashboard: "Overview", stores: "My stores", store: "Store details", orders: "Orders", admin: "Administration", "admin-store": "Store details", audit: "Audit log" })[route.page];

export default function App() {
  const [token, setToken] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [route, setRoute] = useState<Route>(() => routeFor(location.pathname));
  const [stores, setStores] = useState<Store[]>([]);
  const [summary, setSummary] = useState<Summary>({ total: 0, connected: 0, expiringSoon: 0, expired: 0 });
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const page = route.page;

  const navigate = useCallback((next: Route) => {
    setRoute(next);
    if (location.pathname !== pathFor(next)) history.pushState(null, "", pathFor(next));
  }, []);
  const openStore = (store: { id: string }) => navigate({ page: "store", storeId: store.id });

  const load = useCallback(async (access = token) => {
    if (!access) return;
    try {
      const me = await api("/me", access);
      setUser(me.user);
      const [storeData, dashboardData] = await Promise.all([api("/stores", access), api("/dashboard", access)]);
      setStores(storeData);
      setSummary(dashboardData);
    } catch {
      setToken("");
      setUser(null);
    }
  }, [token]);

  useEffect(() => {
    api("/auth/refresh", undefined, { method: "POST" }).then((r) => {
      setToken(r.accessToken); setUser(r.user); return load(r.accessToken);
    }).catch(() => {});
  }, []);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("error") === "daraz_connection_failed") setNotice("Daraz authorization completed, but token exchange failed. See the store's last error below and check the server logs.");
    else if (params.has("error")) setNotice("Daraz authorization was not completed.");
    else if (params.get("connected") === "partial") setNotice("Store connected, but Daraz did not return the seller profile. See the store details for the reason and try \"Refresh details\".");
    else if (params.has("connected")) setNotice("Store connected and seller details saved.");
    if (params.has("error") || params.has("connected")) history.replaceState(null, "", location.pathname);
    const onPop = () => setRoute(routeFor(location.pathname));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    if (user) load();
  }, [user?.id]);

  async function submitAuth(event: FormEvent<HTMLFormElement>, mode: "login" | "signup") {
    event.preventDefault(); setBusy(true); setNotice("");
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const result = await api(`/auth/${mode}`, undefined, { method: "POST", body: JSON.stringify(data) });
      setToken(result.accessToken); setUser(result.user);
      await load(result.accessToken);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to sign in."); }
    finally { setBusy(false); }
  }

  async function logout() {
    await api("/auth/logout", token, { method: "POST" });
    setToken(""); setUser(null); setStores([]);
  }
  async function addStore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true);
    const form = event.currentTarget;
    try {
      await api("/stores", token, { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      form.reset(); await load(); setNotice("Store added.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to add store."); }
    finally { setBusy(false); }
  }
  async function connect(store: Store) {
    try {
      const result = await api(`/stores/${store.id}/connect`, token, { method: "POST" });
      location.assign(result.authorizationUrl);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to connect store."); }
  }
  async function refresh(store: Store) {
    try {
      await api(`/stores/${store.id}/refresh`, token, { method: "POST" });
      await load(); setNotice("Token status updated.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to refresh token."); }
  }
  async function remove(store: Store) {
    if (!confirm(`Remove ${store.label} and its saved tokens?`)) return false;
    try { await api(`/stores/${store.id}`, token, { method: "DELETE" }); await load(); return true; }
    catch (error) { setNotice(error instanceof Error ? error.message : "Unable to remove store."); return false; }
  }
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const result = await api("/auth/password", token, { method: "POST", body: JSON.stringify(fields) });
      setToken(result.accessToken); setUser({ ...user!, mustChangePassword: false }); setNotice("Password changed.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to change password."); }
  }

  if (!user) return <main className="auth-wrap">
    <section className="brand-card"><span className="brand-mark">D</span><p className="eyebrow">SELLER OPERATIONS</p><h1>One hub for every store.</h1><p>Connect your Daraz seller accounts and monitor token health from one secure workspace.</p></section>
    <section className="auth-card"><p className="eyebrow">DARAZ STORE HUB</p><h2>Welcome</h2><p className="muted">Sign in to manage your seller stores.</p>
      <form onSubmit={(e) => submitAuth(e, "login")} className="form-stack">
        <label>Email<input required type="email" name="email" autoComplete="email" /></label>
        <label>Password<input required type="password" name="password" autoComplete="current-password" /></label>
        <button disabled={busy}>{busy ? "Please wait…" : "Sign in"}</button>
      </form>
      <details className="signup"><summary>Create an account</summary><form onSubmit={(e) => submitAuth(e, "signup")} className="form-stack">
        <label>Name<input required name="name" maxLength={100} /></label><label>Email<input required type="email" name="email" /></label>
        <label>Password<input required type="password" name="password" minLength={12} /><small>12+ characters with uppercase, lowercase, number and symbol.</small></label>
        <button disabled={busy}>Create account</button>
      </form></details>
      {notice && <p className="notice error">{notice}</p>}
    </section>
  </main>;

  const isAdminPage = page === "admin" || page === "admin-store";
  return <div className="app-shell">
    <aside className="sidebar"><a className="logo" href="/" onClick={(e) => { e.preventDefault(); navigate({ page: "dashboard" }); }}><span className="brand-mark small">D</span><span>Daraz<span className="muted"> Hub</span></span></a>
      <div className="nav-caption">WORKSPACE</div>
      <button className={page === "dashboard" ? "nav active" : "nav"} onClick={() => navigate({ page: "dashboard" })}>◫ &nbsp;Overview</button>
      <button className={page === "stores" || page === "store" ? "nav active" : "nav"} onClick={() => navigate({ page: "stores" })}>▤ &nbsp;My stores</button>
      <button className={page === "orders" ? "nav active" : "nav"} onClick={() => navigate({ page: "orders" })}>▣ &nbsp;Orders</button>
      {user.role === "admin" && <><div className="nav-caption">ADMINISTRATION</div><button className={isAdminPage ? "nav active" : "nav"} onClick={() => navigate({ page: "admin" })}>♙ &nbsp;Users & stores</button><button className={page === "audit" ? "nav active" : "nav"} onClick={() => navigate({ page: "audit" })}>◷ &nbsp;Audit log</button></>}
      <div className="profile"><span className="avatar">{user.name[0]?.toUpperCase()}</span><div className="profile-text"><strong>{user.name}</strong><small>{user.email}</small></div><button className="icon-button" aria-label="Sign out" onClick={logout}>↗</button></div>
    </aside>
    <main className="main">
      <header className="topbar"><div><p className="eyebrow">YOUR WORKSPACE</p><h1>{titleFor(route)}</h1></div><span className="secure"><span className="dot" /> Secure workspace</span></header>
      {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice("")}>×</button></div>}
      {user.mustChangePassword ? <section className="panel narrow"><h2>Set a new password</h2><p className="muted">The seeded administrator password must be changed before using this account.</p><form className="form-stack" onSubmit={changePassword}><label>Current password<input required name="currentPassword" type="password" /></label><label>New password<input required name="newPassword" type="password" minLength={12} /></label><button>Update password</button></form></section> :
      page === "dashboard" ? <>
        <div className="stat-grid">{[["Total stores", summary.total, "stores connected or pending"], ["Connected", summary.connected, "ready to use"], ["Expiring soon", summary.expiringSoon, "refresh token expires in 7 days"], ["Expired", summary.expired, "reconnect required"]].map(([title, value, sub], i) => <article className="stat-card" key={title}><div className="stat-head"><span>{title}</span><span className={`stat-icon icon-${i}`}>{["▤", "✓", "◷", "!"][i]}</span></div><strong>{value}</strong><small>{sub}</small></article>)}</div>
        <section className="panel"><div className="section-head"><div><h2>Store connections</h2><p className="muted">A quick look at your Daraz seller accounts.</p></div><button className="secondary" onClick={() => navigate({ page: "stores" })}>Manage stores <span>→</span></button></div>
          {stores.length ? <StoreList stores={stores.slice(0, 3)} onOpen={openStore} onConnect={connect} onRefresh={refresh} onRemove={remove} /> : <EmptyStores onClick={() => navigate({ page: "stores" })} />}
        </section>
      </> : page === "stores" ? <>
        <section className="panel add-panel"><div><h2>Add a store</h2><p className="muted">Start with a label and your Daraz marketplace region.</p></div><form className="add-form" onSubmit={addStore}><label>Store label<input required name="label" placeholder="e.g. Kathmandu Outlet" maxLength={100} /></label><label>Country / region<select required name="country" defaultValue=""><option value="" disabled>Select region</option><option value="NP">Nepal (NP)</option><option value="PK">Pakistan (PK)</option><option value="BD">Bangladesh (BD)</option><option value="LK">Sri Lanka (LK)</option><option value="MM">Myanmar (MM)</option></select></label><button disabled={busy}>Add store</button></form></section>
        <section className="panel"><div className="section-head"><div><h2>Your stores <span className="count">{stores.length}</span></h2><p className="muted">Click a store name for its seller details and connection history.</p></div></div>{stores.length ? <StoreList stores={stores} onOpen={openStore} onConnect={connect} onRefresh={refresh} onRemove={remove} /> : <EmptyStores onClick={() => document.querySelector<HTMLInputElement>('input[name="label"]')?.focus()} />}</section>
      </> : page === "store" ? <StoreDetail key={route.storeId} token={token} storeId={route.storeId!} onBack={() => navigate({ page: "stores" })} onConnect={connect} onRefresh={refresh} onRemove={async (store) => { if (await remove(store)) navigate({ page: "stores" }); }} onNotice={setNotice} />
      : page === "admin-store" ? <StoreDetail key={route.storeId} token={token} storeId={route.storeId!} admin onBack={() => navigate({ page: "admin" })} onNotice={setNotice} />
      : page === "orders" ? <Orders token={token} stores={stores} />
      : page === "admin" ? <Admin token={token} onOpenStore={(store) => navigate({ page: "admin-store", storeId: store.id })} /> : <Audit token={token} />}
      <footer>Daraz Store Hub <span>Tokens are encrypted at rest and revealed only on request.</span></footer>
    </main>
  </div>;
}

function EmptyStores({ onClick }: { onClick: () => void }) { return <div className="empty"><span>▤</span><strong>No stores yet</strong><p>Add a Daraz seller store to see its connection and token health here.</p><button className="secondary" onClick={onClick}>Add your first store</button></div>; }
function StoreList({ stores, onOpen, onConnect, onRefresh, onRemove }: { stores: Store[]; onOpen: (store: Store) => void; onConnect: (store: Store) => void; onRefresh: (store: Store) => void; onRemove: (store: Store) => void }) {
  return <div className="store-list">{stores.map((store) => {
    const refreshDays = daysUntil(store.refreshExpiresAt);
    return <article className="store-row" key={store.id}><div className="store-avatar">▤</div><div className="store-info"><div className="store-title"><button className="link-button" onClick={() => onOpen(store)} aria-label={`View details for ${store.label}`}>{store.label}</button><span className={`badge ${store.status}`}>{store.status.replace("_", " ")}</span></div><span className="muted">{store.country} marketplace{store.sellerName ? ` · ${store.sellerName}` : ""}{store.sellerId ? ` · Seller ${store.sellerId}` : ""}</span><small>Access expires: {dateLabel(store.accessExpiresAt)}</small>{refreshDays !== null && refreshDays <= 7 && <small className="warning">Refresh token expires in {Math.max(refreshDays, 0)} days — reconnect soon.</small>}{store.lastError && <small className="warning">{store.lastError}</small>}</div><div className="store-actions"><button className="secondary" onClick={() => onConnect(store)}>{connectLabel(store)}</button><button className="text-button" disabled={!store.refreshExpiresAt || refreshDays !== null && refreshDays <= 0} onClick={() => onRefresh(store)}>Get new access token</button><button className="remove-button" onClick={() => onRemove(store)}>Remove</button></div></article>;
  })}</div>;
}

function Details({ rows }: { rows: Array<[string, ReactNode, string?]> }) {
  return <dl className="detail-grid">{rows.map(([term, value, className]) => <div key={term}><dt>{term}</dt><dd className={className}>{value === null || value === undefined || value === "" ? "—" : value}</dd></div>)}</dl>;
}
function StoreDetail({ token, storeId, admin = false, onBack, onConnect, onRefresh, onRemove, onNotice }: {
  token: string; storeId: string; admin?: boolean; onBack: () => void;
  onConnect?: (store: Store) => void; onRefresh?: (store: Store) => Promise<void>; onRemove?: (store: Store) => Promise<void>; onNotice: (message: string) => void;
}) {
  const [store, setStore] = useState<StoreDetails | null>(null);
  const [storeTokens, setStoreTokens] = useState<StoreTokens | null>(null);
  const [tokensLoading, setTokensLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const path = admin ? `/admin/stores/${storeId}` : `/stores/${storeId}`;
  const reload = useCallback(() => api(path, token).then((data) => { setStore(data); setError(""); }).catch((e) => setError(e.message)), [path, token]);
  useEffect(() => { reload(); }, [reload]);
  const syncQueued = Boolean(store?.orderSyncNextAt && new Date(store.orderSyncNextAt).getTime() <= Date.now());
  useEffect(() => {
    if (!store?.orderSyncRunning && !syncQueued) return;
    const timer = setInterval(() => { void reload(); }, 5000);
    return () => clearInterval(timer);
  }, [store?.orderSyncRunning, syncQueued, reload]);

  async function refreshProfile() {
    if (!store) return;
    setBusy(true);
    try { await api(`/stores/${store.id}/profile`, token, { method: "POST" }); await reload(); onNotice("Seller details updated from Daraz."); }
    catch (e) { onNotice(e instanceof Error ? e.message : "Unable to refresh seller details."); }
    finally { setBusy(false); }
  }
  async function refreshToken() {
    if (!store || !onRefresh) return;
    setBusy(true);
    try { await onRefresh(store); setStoreTokens(null); await reload(); } finally { setBusy(false); }
  }
  async function toggleStoreTokens() {
    if (storeTokens) {
      setStoreTokens(null);
      return;
    }
    setTokensLoading(true);
    try {
      const credentials = await api(`/stores/${storeId}/tokens`, token, { cache: "no-store" });
      setStoreTokens(credentials);
    } catch (e) {
      onNotice(e instanceof Error ? e.message : "Unable to reveal store tokens.");
    } finally {
      setTokensLoading(false);
    }
  }
  async function saveOrderSyncSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!store) return;
    const values = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    try {
      await api(`/stores/${store.id}/order-sync-settings`, token, {
        method: "PATCH",
        body: JSON.stringify({ fromDate: values.fromDate, frequency: values.frequency }),
      });
      await reload();
      onNotice("Order sync settings saved.");
    } catch (e) {
      onNotice(e instanceof Error ? e.message : "Unable to save order sync settings.");
    } finally {
      setBusy(false);
    }
  }
  async function syncOrdersNow() {
    if (!store) return;
    setBusy(true);
    try {
      await api(`/stores/${store.id}/orders/sync`, token, { method: "POST" });
      await reload();
      onNotice("Order and product sync queued.");
    } catch (e) {
      onNotice(e instanceof Error ? e.message : "Unable to queue order sync.");
    } finally {
      setBusy(false);
    }
  }

  const back = <button className="back-button" onClick={onBack}>← {admin ? "All stores" : "My stores"}</button>;
  if (error) return <section className="panel">{back}<p className="notice error">{error}</p></section>;
  if (!store) return <section className="panel">{back}<p className="muted">Loading store…</p></section>;
  const refreshDays = daysUntil(store.refreshExpiresAt);
  const accessValid = Boolean(store.accessExpiresAt) && new Date(store.accessExpiresAt!).getTime() > Date.now();
  const hasIdentity = Boolean(store.sellerId || store.account || store.profileFetchedAt);
  return <>
    <section className="panel">{back}
      <div className="detail-head"><div className="store-avatar">▤</div><div className="store-info"><div className="store-title"><h2>{store.label}</h2><span className={`badge ${store.status}`}>{store.status.replace("_", " ")}</span>{store.verified && <span className="badge connected">Verified</span>}</div><span className="muted">{store.country} marketplace{store.sellerName ? ` · ${store.sellerName}` : ""}{store.shortCode ? ` · ${store.shortCode}` : ""}</span>{admin && store.user && <small>Owner: {store.user.name} ({store.user.email})</small>}</div>
        {!admin && <div className="store-actions"><button className="secondary" onClick={() => onConnect?.(store)}>{connectLabel(store)}</button><button className="text-button" disabled={busy || !store.refreshExpiresAt || refreshDays !== null && refreshDays <= 0} onClick={refreshToken}>Get new access token</button><button className="text-button" disabled={busy || !accessValid} title={accessValid ? "Fetch the latest seller profile from Daraz" : "Requires a valid access token"} onClick={refreshProfile}>Refresh details</button><button className="remove-button" onClick={() => onRemove?.(store)}>Remove</button></div>}
      </div>
    </section>
    <section className="panel"><h2>Seller account</h2><p className="muted">{hasIdentity ? "Captured from Daraz when this store was authorized." : "Seller details are captured from Daraz when you connect the store."}</p>
      <Details rows={[
        ["Seller name", store.sellerName], ["Company", store.companyName], ["Seller ID", store.sellerId], ["Short code", store.shortCode],
        ["Daraz account", store.account], ["Seller email", store.sellerEmail], ["Account platform", store.accountPlatform], ["Daraz user ID", store.darazUserId],
        ["Marketplace", store.darazCountry ?? store.country], ["Location", store.location], ["Seller status", store.sellerStatus], ["Verified", store.verified === null ? null : store.verified ? "Yes" : "No"],
        ["Details fetched", store.profileFetchedAt ? dateLabel(store.profileFetchedAt) : null], ...(store.profileError ? [["Profile error", store.profileError, "warning"] as [string, ReactNode, string]] : []),
      ]} />
    </section>
    <section className="panel"><h2>Connection & tokens</h2><p className="muted">Tokens are encrypted at rest. Reveal them only when needed, and keep them private.</p>
      <Details rows={[
        ["Status", store.status.replace("_", " ")], ["First connected", store.connectedAt ? dateLabel(store.connectedAt) : null], ["Access token expires", dateLabel(store.accessExpiresAt)],
        ["Refresh token expires", dateLabel(store.refreshExpiresAt)], ["Last token refresh", store.lastRefreshedAt ? dateLabel(store.lastRefreshedAt) : "Never"], ["Store added", dateLabel(store.createdAt)],
        ...(store.lastError ? [["Last error", store.lastError, "warning"] as [string, ReactNode, string]] : []),
      ]} />
      {!admin && <div className="token-controls">
        <button className="secondary" disabled={tokensLoading} onClick={toggleStoreTokens}>
          {tokensLoading ? "Loading tokens…" : storeTokens ? "Hide tokens" : "Show tokens"}
        </button>
        {storeTokens && <div className="token-values">
          <label>Access token<input type="text" readOnly autoComplete="off" spellCheck={false} value={storeTokens.accessToken} /></label>
          <label>Refresh token<input type="text" readOnly autoComplete="off" spellCheck={false} value={storeTokens.refreshToken} /></label>
        </div>}
      </div>}
      {refreshDays !== null && refreshDays <= 7 && <p className="notice">Refresh token expires in {Math.max(refreshDays, 0)} days — reconnect soon.</p>}
    </section>
    {!admin && <section className="panel">
      <div className="section-head"><div><h2>Order & product sync</h2><p className="muted">Orders and their product details are saved locally and refreshed on this schedule.</p></div>
        <button disabled={busy || store.orderSyncRunning || !store.accessExpiresAt && !store.refreshExpiresAt} onClick={syncOrdersNow}>{store.orderSyncRunning ? "Syncing…" : "Sync now"}</button>
      </div>
      <form className="sync-settings" onSubmit={saveOrderSyncSettings}>
        <label>Sync orders from<input required type="date" name="fromDate" max={new Date().toISOString().slice(0, 10)} defaultValue={store.orderSyncFrom?.slice(0, 10)} /></label>
        <label>Sync frequency<select name="frequency" defaultValue={store.orderSyncFrequency}>
          <option value="manual">Manual only</option><option value="every_15_minutes">Every 15 minutes</option>
          <option value="hourly">Hourly</option><option value="every_6_hours">Every 6 hours</option><option value="daily">Daily</option>
        </select></label>
        <button className="secondary" disabled={busy}>Save settings</button>
      </form>
      <Details rows={[
        ["Last sync", store.orderSyncLastAt ? dateLabel(store.orderSyncLastAt) : "Never"],
        ["Next sync", store.orderSyncNextAt ? dateLabel(store.orderSyncNextAt) : store.orderSyncFrequency === "manual" ? "Manual only" : "Not scheduled"],
        ["Sync status", store.orderSyncRunning ? "Running" : syncQueued ? "Queued" : store.orderSyncError ? "Needs attention" : "Idle"],
        ...(store.orderSyncError ? [["Sync error", store.orderSyncError, "warning"] as [string, ReactNode, string]] : []),
      ]} />
    </section>}
    <section className="panel"><h2>Recent activity</h2>{store.activity.length ? <div className="table-wrap"><table><thead><tr><th>Event</th><th>Details</th><th>Time</th></tr></thead><tbody>{store.activity.map((row) => <tr key={row.id}><td>{row.action.replaceAll("_", " ")}</td><td>{row.meta?.reason ? <><strong>{row.meta.phase?.replaceAll("_", " ") ?? "Details"}</strong><small>{row.meta.reason}</small></> : "—"}</td><td>{dateLabel(row.createdAt)}</td></tr>)}</tbody></table></div> : <p className="muted">No activity recorded yet.</p>}</section>
  </>;
}

type OrderRow = {
  id: string; storeId: string; darazOrderId: string; customerName: string | null;
  orderCreatedAt: string; orderUpdatedAt: string | null; orderStatus: string | null;
  deliveryStatus: string | null; trackingNumber: string | null;
  store: { label: string; country: string };
};

function Orders({ token, stores }: { token: string; stores: Store[] }) {
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [storeId, setStoreId] = useState("");
  const [search, setSearch] = useState("");
  const [orderStatus, setOrderStatus] = useState("");
  const [deliveryStatus, setDeliveryStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sortBy, setSortBy] = useState("createdAt");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams({
      page: String(page), pageSize: String(pageSize), sortBy, sortOrder,
    });
    if (storeId) params.set("storeId", storeId);
    if (search) params.set("search", search);
    if (orderStatus) params.set("orderStatus", orderStatus);
    if (deliveryStatus) params.set("deliveryStatus", deliveryStatus);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    let current = true;
    setLoading(true);
    api(`/orders?${params}`, token).then((data) => {
      if (!current) return;
      setRows(data.orders);
      setTotal(data.total);
      setTotalPages(data.totalPages);
      setError("");
    }).catch((e) => {
      if (current) setError(e instanceof Error ? e.message : "Unable to load orders.");
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [token, page, pageSize, storeId, search, orderStatus, deliveryStatus, from, to, sortBy, sortOrder]);

  function toggleSort(field: string) {
    if (sortBy === field) setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    else { setSortBy(field); setSortOrder("asc"); }
    setPage(1);
  }
  const sortable = (field: string, title: string) =>
    <button className="table-sort" onClick={() => toggleSort(field)}>{title}{sortBy === field ? (sortOrder === "asc" ? " ↑" : " ↓") : ""}</button>;
  const pageText = total === 0 ? "0 orders" : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`;

  return <>
    <section className="panel">
      <div className="section-head"><div><h2>Orders <span className="count">{total}</span></h2><p className="muted">Synced orders and their latest Daraz status.</p></div></div>
      <div className="order-filters">
        <label>Store<select value={storeId} onChange={(event) => { setStoreId(event.target.value); setPage(1); }}>
          <option value="">All stores</option>{stores.map((store) => <option key={store.id} value={store.id}>{store.label} ({store.country})</option>)}
        </select></label>
        <label>Search<input type="search" maxLength={200} placeholder="Order, customer or tracking number" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} /></label>
        <label>Order status<input maxLength={100} value={orderStatus} placeholder="Any status" onChange={(event) => { setOrderStatus(event.target.value); setPage(1); }} /></label>
        <label>Delivery status<input maxLength={100} value={deliveryStatus} placeholder="Any status" onChange={(event) => { setDeliveryStatus(event.target.value); setPage(1); }} /></label>
        <label>Created from<input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} /></label>
        <label>Created to<input type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} /></label>
        <label>Rows<select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label>
      </div>
      {error && <p className="notice error">{error}</p>}
      <div className="table-wrap orders-table"><table>
        <thead><tr><th>{sortable("customerName", "Customer")}</th><th>{sortable("orderId", "Order ID")}</th><th>Store</th><th>{sortable("createdAt", "Created")}</th><th>{sortable("updatedAt", "Updated")}</th><th>{sortable("orderStatus", "Order status")}</th><th>{sortable("deliveryStatus", "Delivery status")}</th><th>{sortable("trackingNumber", "Tracking number")}</th></tr></thead>
        <tbody>{rows.map((order) => <tr key={order.id}>
          <td>{order.customerName ?? "—"}</td><td>{order.darazOrderId}</td><td>{order.store.label}</td>
          <td>{dateLabel(order.orderCreatedAt)}</td><td>{dateLabel(order.orderUpdatedAt)}</td>
          <td>{order.orderStatus ?? "—"}</td><td>{order.deliveryStatus ?? "—"}</td><td>{order.trackingNumber ?? "—"}</td>
        </tr>)}
        {!loading && rows.length === 0 && <tr><td colSpan={8} className="orders-empty">No orders found. Connect a store and run an order sync, or adjust the filters.</td></tr>}
        {loading && <tr><td colSpan={8} className="orders-empty">Loading orders…</td></tr>}
        </tbody></table></div>
      <div className="pagination"><span>{pageText}</span><div><button className="secondary" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} of {Math.max(totalPages, 1)}</span><button className="secondary" disabled={page >= totalPages || loading} onClick={() => setPage(page + 1)}>Next</button></div></div>
    </section>
  </>;
}

function Admin({ token, onOpenStore }: { token: string; onOpenStore: (store: Store) => void }) {
  const [users, setUsers] = useState<any[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => { const [u, s] = await Promise.all([api("/admin/users", token), api("/admin/stores", token)]); setUsers(u); setStores(s); }, [token]);
  useEffect(() => { load().catch((e) => setMessage(e.message)); }, [load]);
  async function toggle(user: any) { await api(`/admin/users/${user.id}`, token, { method: "PATCH", body: JSON.stringify({ isActive: !user.isActive }) }); await load(); }
  async function reset(user: any) { const password = prompt("Enter a temporary password (12+ characters, upper/lowercase, number and symbol):"); if (!password) return; await api(`/admin/users/${user.id}`, token, { method: "PATCH", body: JSON.stringify({ password }) }); setMessage("Password reset. User must sign in and change it."); }
  return <><section className="panel"><div className="section-head"><div><h2>Users <span className="count">{users.length}</span></h2><p className="muted">Activate accounts or reset passwords.</p></div></div>{message && <p className="notice">{message}</p>}<div className="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Stores</th><th>Status</th><th>Actions</th></tr></thead><tbody>{users.map((u) => <tr key={u.id}><td><strong>{u.name}</strong><small>{u.email}</small></td><td>{u.role}</td><td>{u._count.stores}</td><td><span className={`badge ${u.isActive ? "connected" : "error"}`}>{u.isActive ? "Active" : "Inactive"}</span></td><td><button className="text-button" onClick={() => toggle(u)}>{u.isActive ? "Deactivate" : "Activate"}</button><button className="text-button" onClick={() => reset(u)}>Reset password</button></td></tr>)}</tbody></table></div></section><section className="panel"><h2>All stores <span className="count">{stores.length}</span></h2><div className="table-wrap"><table><thead><tr><th>Store</th><th>Seller</th><th>Owner</th><th>Region</th><th>Status</th><th>Refresh expires</th></tr></thead><tbody>{stores.map((s) => <tr key={s.id}><td><button className="link-button" onClick={() => onOpenStore(s)}>{s.label}</button></td><td>{s.sellerName ?? s.account ?? "—"}{s.sellerId && <small>Seller {s.sellerId}</small>}</td><td>{s.user?.email}</td><td>{s.country}</td><td>{s.status}</td><td>{dateLabel(s.refreshExpiresAt)}</td></tr>)}</tbody></table></div></section></>;
}
function Audit({ token }: { token: string }) {
  const [rows, setRows] = useState<Array<Activity & { user?: { email: string } | null; store?: { label: string } | null }>>([]);
  useEffect(() => { api("/admin/audit", token).then(setRows).catch(() => setRows([])); }, [token]);
  return <section className="panel"><h2>Recent activity</h2><div className="table-wrap"><table><thead><tr><th>Event</th><th>User</th><th>Store</th><th>Details</th><th>Time</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{row.action.replaceAll("_", " ")}</td><td>{row.user?.email ?? "System"}</td><td>{row.store?.label ?? "—"}</td><td>{row.meta?.reason ? <><strong>{row.meta.phase?.replaceAll("_", " ") ?? "Details"}</strong><small>{row.meta.reason}</small></> : "—"}</td><td>{dateLabel(row.createdAt)}</td></tr>)}</tbody></table></div></section>;
}
