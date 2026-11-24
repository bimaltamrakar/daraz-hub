import { FormEvent, ReactNode, useCallback, useEffect, useState } from "react";
import "./orders.css";

type User = { id: string; name: string; email: string; role: "admin" | "user"; mustChangePassword: boolean };
type Store = {
  id: string; label: string; country: string; status: string; createdAt: string;
  storeType?: "normal" | "choice"; isActive?: boolean;
  sellerId: string | null; sellerName: string | null; companyName: string | null; sellerEmail: string | null; shortCode: string | null;
  account: string | null; accountPlatform: string | null; darazCountry: string | null; darazUserId: string | null;
  sellerStatus: string | null; verified: boolean | null; location: string | null; connectedAt: string | null;
  profile: Record<string, unknown> | null; profileFetchedAt: string | null; profileError: string | null;
  accessExpiresAt: string | null; refreshExpiresAt: string | null; lastRefreshedAt: string | null; lastError: string | null;
  orderSyncFrom: string; orderSyncFrequency: string; orderSyncLastAt: string | null; orderSyncNextAt: string | null; productSyncLastAt: string | null;
  orderSyncCursor?: string | null;
  orderSyncError: string | null; orderSyncRunning?: boolean;
  productSyncNextAt?: string | null;
  productSyncOffset?: number; productSyncError?: string | null; productSyncRunning?: boolean;
  orderBackfillDone?: boolean; orderBackfillCursor?: string | null;
  _count?: { orders: number; products: number };
  user?: { name: string; email: string };
};
type Activity = { id: string; action: string; createdAt: string; meta?: { phase?: string; reason?: string } | null };
type StoreDetails = Store & { activity: Activity[] };
type StoreTokens = { accessToken: string; refreshToken: string };
type Summary = { total: number; connected: number; expiringSoon: number; expired: number };
type Route = { page: "dashboard" | "stores" | "store" | "store-settings" | "orders" | "products" | "admin" | "admin-store" | "admin-logs" | "audit" | "ims-invoices" | "ims-history" | "ims-settings"; storeId?: string };

const NAV_STORAGE_KEY = "daraz-hub-sidebar";

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
  if (pathname.startsWith("/admin/logs")) return { page: "admin-logs" };
  if (pathname.startsWith("/ims/settings")) return { page: "ims-settings" };
  if (pathname.startsWith("/ims/history")) return { page: "ims-history" };
  if (pathname.startsWith("/ims")) return { page: "ims-invoices" };
  if (pathname.startsWith("/admin")) return { page: "admin" };
  if (pathname.startsWith("/audit")) return { page: "audit" };
  if (pathname.startsWith("/orders")) return { page: "orders" };
  if (pathname.startsWith("/products")) return { page: "products" };
  const storeSettings = pathname.match(/^\/stores\/([^/]+)\/settings/);
  if (storeSettings) return { page: "store-settings", storeId: storeSettings[1] };
  const store = pathname.match(/^\/stores\/([^/]+)/);
  if (store) return { page: "store", storeId: store[1] };
  if (pathname.startsWith("/stores")) return { page: "stores" };
  return { page: "dashboard" };
}
const pathFor = (route: Route) =>
  route.page === "store" ? `/stores/${route.storeId}` : route.page === "store-settings" ? `/stores/${route.storeId}/settings` : route.page === "admin-store" ? `/admin/stores/${route.storeId}` : route.page === "dashboard" ? "/" : route.page === "admin-logs" ? "/admin/logs" : route.page === "ims-invoices" ? "/ims/invoices" : route.page === "ims-history" ? "/ims/history" : route.page === "ims-settings" ? "/ims/settings" : `/${route.page}`;
const titleFor = (route: Route) =>
  ({ dashboard: "Overview", stores: "My stores", store: "Store details", "store-settings": "Store settings", orders: "Order management", products: "Product catalog", admin: "Administration", "admin-store": "Store details", "admin-logs": "Store logs", audit: "Audit log", "ims-invoices": "Invoice Management", "ims-history": "Invoice History", "ims-settings": "IMS Settings" })[route.page];

function NavIcon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="1.6" /><rect x="14" y="3" width="7" height="7" rx="1.6" /><rect x="3" y="14" width="7" height="7" rx="1.6" /><rect x="14" y="14" width="7" height="7" rx="1.6" /></>,
    orders: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z" /><path d="M9 8h6M9 12h6" /></>,
    products: <><path d="M21 8l-9-5-9 5 9 5 9-5z" /><path d="M3 8v8l9 5 9-5V8" /></>,
    stores: <><path d="M4 9h16l-1 11H5L4 9z" /><path d="M8 9V6a4 4 0 018 0v3" /></>,
    users: <><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3 3-5 6-5s6 2 6 5" /><circle cx="17" cy="9" r="2" /><path d="M17 14c2 0 4 1 4 3" /></>,
    logs: <><path d="M5 5h14M5 12h14M5 19h9" /></>,
    audit: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export default function App() {
  const [token, setToken] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [route, setRoute] = useState<Route>(() => routeFor(location.pathname));
  const [stores, setStores] = useState<Store[]>([]);
  const [summary, setSummary] = useState<Summary>({ total: 0, connected: 0, expiringSoon: 0, expired: 0 });
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [showInactiveStores, setShowInactiveStores] = useState(false);
  const [navOpen, setNavOpen] = useState(() => {
    try { return localStorage.getItem(NAV_STORAGE_KEY) !== "closed"; } catch { return true; }
  });
  const page = route.page;

  useEffect(() => {
    try { localStorage.setItem(NAV_STORAGE_KEY, navOpen ? "open" : "closed"); } catch { /* storage unavailable */ }
  }, [navOpen]);

  const navigate = useCallback((next: Route) => {
    setRoute(next);
    if (location.pathname !== pathFor(next)) history.pushState(null, "", pathFor(next));
  }, []);
  const toggleNav = useCallback(() => setNavOpen((open) => !open), []);
  const openStore = (store: { id: string }) => navigate({ page: "store", storeId: store.id });
  const openStoreSettings = (store: { id: string }) => navigate({ page: "store-settings", storeId: store.id });

  const load = useCallback(async (access = token) => {
    if (!access) return;
    try {
      const me = await api("/me", access);
      setUser(me.user);
      const [storeData, dashboardData] = await Promise.all([
        api(`/stores${showInactiveStores ? "?includeInactive=1" : ""}`, access),
        api("/dashboard", access),
      ]);
      setStores(storeData);
      setSummary(dashboardData);
    } catch {
      setToken("");
      setUser(null);
    }
  }, [token, showInactiveStores]);

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
  useEffect(() => {
    if (token) void load();
  }, [showInactiveStores]);

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

  const isAdminPage = page === "admin" || page === "admin-store" || page === "admin-logs";
  return <div className={navOpen ? "app-shell" : "app-shell nav-collapsed"}>
    <aside className="sidebar" id="app-sidebar" inert={!navOpen}><a className="logo" href="/" onClick={(e) => { e.preventDefault(); navigate({ page: "dashboard" }); }}><span className="brand-mark small">D</span><span className="brand-text"><strong>Daraz</strong><span>Store Hub</span></span></a>
      <div className="nav-items">
        <button className={page === "dashboard" ? "nav active" : "nav"} onClick={() => navigate({ page: "dashboard" })}><NavIcon name="overview" /><span>Overview</span></button>
        <button className={page === "orders" ? "nav active" : "nav"} onClick={() => navigate({ page: "orders" })}><NavIcon name="orders" /><span>Orders</span></button>
        <button className={page === "products" ? "nav active" : "nav"} onClick={() => navigate({ page: "products" })}><NavIcon name="products" /><span>Products</span></button>
        <button className={page === "stores" || page === "store" ? "nav active" : "nav"} onClick={() => navigate({ page: "stores" })}><NavIcon name="stores" /><span>My stores</span></button>
      </div>
      {user.role === "admin" && <><div className="nav-divider" /><div className="nav-items">
        <button className={page === "admin" ? "nav active" : "nav"} onClick={() => navigate({ page: "admin" })}><NavIcon name="users" /><span>Users & stores</span></button>
        <button className={page === "admin-logs" ? "nav active" : "nav"} onClick={() => navigate({ page: "admin-logs" })}><NavIcon name="logs" /><span>Store logs</span></button>
        <button className={page === "audit" ? "nav active" : "nav"} onClick={() => navigate({ page: "audit" })}><NavIcon name="audit" /><span>Audit log</span></button>
      </div></>}
      <div className="nav-divider" />
      <div className="nav-caption">IMS</div>
      <div className="nav-items">
        <button className={page === "ims-invoices" ? "nav active" : "nav"} onClick={() => navigate({ page: "ims-invoices" })}><NavIcon name="orders" /><span>Invoice Management</span></button>
        <button className={page === "ims-history" ? "nav active" : "nav"} onClick={() => navigate({ page: "ims-history" })}><NavIcon name="logs" /><span>Invoice History</span></button>
        {user.role === "admin" && <button className={page === "ims-settings" ? "nav active" : "nav"} onClick={() => navigate({ page: "ims-settings" })}><NavIcon name="audit" /><span>IMS Settings</span></button>}
      </div>
      <div className="sidebar-language"><span className="globe">◎</span> English</div>
      <div className="profile"><span className="avatar">{user.name[0]?.toUpperCase()}</span><div className="profile-text"><strong>{user.name}</strong><small>{user.email}</small></div><button className="icon-button" aria-label="Sign out" onClick={logout}>↗</button></div>
    </aside>
    <main className="main">
      <header className="topbar"><div className="topbar-left"><button type="button" className="nav-toggle" onClick={toggleNav} aria-label={navOpen ? "Hide navigation menu" : "Show navigation menu"} aria-expanded={navOpen} aria-controls="app-sidebar" title={navOpen ? "Hide navigation" : "Show navigation"}><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg></button><div><p className="eyebrow">YOUR WORKSPACE</p><h1>{titleFor(route)}</h1></div></div><span className="secure"><span className="dot" /> Secure workspace</span></header>
      {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice("")}>×</button></div>}
      {user.mustChangePassword ? <section className="panel narrow"><h2>Set a new password</h2><p className="muted">The seeded administrator password must be changed before using this account.</p><form className="form-stack" onSubmit={changePassword}><label>Current password<input required name="currentPassword" type="password" /></label><label>New password<input required name="newPassword" type="password" minLength={12} /></label><button>Update password</button></form></section> :
      page === "dashboard" ? <Dashboard token={token} onOpenStore={openStore} onManageStores={() => navigate({ page: "stores" })} /> : page === "stores" ? <>
        <section className="panel add-panel"><div><h2>Add a store</h2><p className="muted">Start with a label and your Daraz marketplace region.</p></div><form className="add-form" onSubmit={addStore}><label>Store label<input required name="label" placeholder="e.g. Kathmandu Outlet" maxLength={100} /></label><label>Country / region<select required name="country" defaultValue=""><option value="" disabled>Select region</option><option value="NP">Nepal (NP)</option><option value="PK">Pakistan (PK)</option><option value="BD">Bangladesh (BD)</option><option value="LK">Sri Lanka (LK)</option><option value="MM">Myanmar (MM)</option></select></label><button disabled={busy}>Add store</button></form></section>
        <section className="panel"><div className="section-head"><div><h2>Your stores <span className="count">{stores.length}</span></h2><p className="muted">Click a store name for its seller details and connection history.</p></div><div className="head-actions"><button className={showInactiveStores ? "secondary live-on" : "secondary"} onClick={() => setShowInactiveStores((value) => !value)}>{showInactiveStores ? "Hide inactive" : "Show inactive"}</button></div></div>{stores.length ? <StoreList stores={stores} onOpen={openStore} onConnect={connect} onRefresh={refresh} onRemove={remove} onSettings={openStoreSettings} /> : <EmptyStores onClick={() => document.querySelector<HTMLInputElement>('input[name="label"]')?.focus()} />}</section>
      </> : page === "store" ? <StoreDetail key={route.storeId} token={token} storeId={route.storeId!} onBack={() => navigate({ page: "stores" })} onConnect={connect} onRefresh={refresh} onRemove={async (store) => { if (await remove(store)) navigate({ page: "stores" }); }} onSettings={() => navigate({ page: "store-settings", storeId: route.storeId! })} onNotice={setNotice} />
      : page === "store-settings" ? <StoreSettings key={route.storeId} token={token} storeId={route.storeId!} onBack={() => navigate({ page: "store", storeId: route.storeId! })} onNotice={setNotice} />
      : page === "admin-store" ? <StoreDetail key={route.storeId} token={token} storeId={route.storeId!} admin onBack={() => navigate({ page: "admin" })} onNotice={setNotice} />
      : page === "orders" ? <Orders token={token} stores={stores} />
      : page === "products" ? <Products token={token} stores={stores} />
      : page === "ims-invoices" ? <ImsInvoices token={token} />
      : page === "ims-history" ? <ImsInvoices token={token} history />
      : page === "ims-settings" ? <ImsSettings token={token} />
      : page === "admin-logs" ? <AdminLogs token={token} /> : page === "admin" ? <Admin token={token} onOpenStore={(store) => navigate({ page: "admin-store", storeId: store.id })} /> : <Audit token={token} />}
      <footer>Daraz Store Hub <span>Tokens are encrypted at rest and revealed only on request.</span></footer>
    </main>
  </div>;
}

function EmptyStores({ onClick }: { onClick: () => void }) { return <div className="empty"><span>▤</span><strong>No stores yet</strong><p>Add a Daraz seller store to see its connection and token health here.</p><button className="secondary" onClick={onClick}>Add your first store</button></div>; }
function StoreList({ stores, onOpen, onConnect, onRefresh, onRemove, onSettings }: { stores: Store[]; onOpen: (store: Store) => void; onConnect: (store: Store) => void; onRefresh: (store: Store) => void; onRemove: (store: Store) => void; onSettings: (store: Store) => void }) {
  return <div className="store-list">{stores.map((store) => {
    const refreshDays = daysUntil(store.refreshExpiresAt);
    return <article className={store.isActive === false ? "store-row inactive" : "store-row"} key={store.id}><div className="store-avatar">▤</div><div className="store-info"><div className="store-title"><button className="link-button" onClick={() => onOpen(store)} aria-label={`View details for ${store.label}`}>{store.label}</button><span className={`badge ${store.status}`}>{store.status.replace("_", " ")}</span>{store.isActive === false && <span className="badge error">Inactive</span>}</div><span className="muted">{store.country} marketplace{store.sellerName ? ` · ${store.sellerName}` : ""}{store.sellerId ? ` · Seller ${store.sellerId}` : ""}{store.storeType === "choice" ? " · Choice seller" : ""}</span><small>Access expires: {dateLabel(store.accessExpiresAt)}</small>{refreshDays !== null && refreshDays <= 7 && <small className="warning">Refresh token expires in {Math.max(refreshDays, 0)} days — reconnect soon.</small>}{store.lastError && <small className="warning">{store.lastError}</small>}</div><div className="store-actions"><button className="secondary" disabled={store.isActive === false} title={store.isActive === false ? "Activate the store to connect it" : undefined} onClick={() => onConnect(store)}>{connectLabel(store)}</button><button className="text-button" disabled={store.isActive === false || !store.refreshExpiresAt || refreshDays !== null && refreshDays <= 0} onClick={() => onRefresh(store)}>Get new access token</button><button className="text-button" onClick={() => onSettings(store)}>Settings</button><button className="remove-button" onClick={() => onRemove(store)}>Remove</button></div></article>;
  })}</div>;
}

function Details({ rows }: { rows: Array<[string, ReactNode, string?]> }) {
  return <dl className="detail-grid">{rows.map(([term, value, className]) => <div key={term}><dt>{term}</dt><dd className={className}>{value === null || value === undefined || value === "" ? "—" : value}</dd></div>)}</dl>;
}

function StoreSettings({ token, storeId, onBack, onNotice }: { token: string; storeId: string; onBack: () => void; onNotice: (message: string) => void }) {
  const [store, setStore] = useState<StoreDetails | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  const reload = useCallback(() => api(`/stores/${storeId}`, token).then((data) => { setStore(data); setError(""); }).catch((e) => setError(e.message)), [storeId, token]);
  useEffect(() => { void reload(); }, [reload]);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!store) return;
    const values = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setSaved("");
    try {
      await api(`/stores/${store.id}/order-sync-settings`, token, {
        method: "PATCH",
        body: JSON.stringify({ fromDate: values.fromDate, frequency: values.frequency }),
      });
      await reload();
      setSaved("Settings saved. Changing the start date restarts the order backfill from that date.");
      onNotice("Store sync settings saved.");
    } catch (e) {
      onNotice(e instanceof Error ? e.message : "Unable to save settings.");
    } finally {
      setBusy(false);
    }
  }

  async function syncNow() {
    if (!store) return;
    setBusy(true);
    try {
      await api(`/stores/${store.id}/orders/sync`, token, { method: "POST" });
      await reload();
      onNotice("Order and product sync queued for this store.");
    } catch (e) {
      onNotice(e instanceof Error ? e.message : "Unable to queue a sync.");
    } finally {
      setBusy(false);
    }
  }

  async function syncProducts() {
    if (!store) return;
    setBusy(true);
    try {
      await api(`/stores/${store.id}/products/sync`, token, { method: "POST" });
      await reload();
      onNotice("Product catalog sync queued (runs with the store sync).");
    } catch (e) {
      onNotice(e instanceof Error ? e.message : "Unable to queue a product sync.");
    } finally {
      setBusy(false);
    }
  }

  async function fullResyncProducts() {
    if (!store) return;
    if (!confirm(`Re-fetch the entire product catalog for ${store.label}? This clears the saved sync cursor and restarts from the beginning.`)) return;
    setBusy(true);
    try {
      await api(`/stores/${store.id}/products/resync`, token, { method: "POST" });
      await reload();
      onNotice("Full product resync queued — it restarts from the beginning of the catalog.");
    } catch (e) {
      onNotice(e instanceof Error ? e.message : "Unable to queue a full product resync.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive() {
    if (!store) return;
    const activate = store.isActive === false;
    if (!confirm(activate
      ? `Activate ${store.label}? It will reappear in lists, reports and syncs.`
      : `Deactivate ${store.label}? It will be hidden from lists, reports and syncs until reactivated.`)) return;
    setBusy(true);
    try {
      await api(`/stores/${store.id}/active`, token, { method: "PATCH", body: JSON.stringify({ isActive: activate }) });
      await reload();
      onNotice(activate ? "Store activated." : "Store deactivated — hidden from lists, reports and syncs.");
    } catch (e) {
      onNotice(e instanceof Error ? e.message : "Unable to change store status.");
    } finally {
      setBusy(false);
    }
  }

  async function saveStoreType(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!store) return;
    const values = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    try {
      await api(`/stores/${store.id}/type`, token, {
        method: "PATCH",
        body: JSON.stringify({ storeType: values.storeType }),
      });
      await reload();
      onNotice(values.storeType === "choice"
        ? "Store marked as a Choice seller. AWB printing is disabled for this store."
        : "Store marked as a normal seller. AWB printing is enabled.");
    } catch (e) {
      onNotice(e instanceof Error ? e.message : "Unable to update the seller type.");
    } finally {
      setBusy(false);
    }
  }

  const back = <button className="back-button" onClick={onBack}>← Store details</button>;
  if (error) return <section className="panel">{back}<p className="notice error">{error}</p></section>;
  if (!store) return <section className="panel">{back}<p className="muted">Loading settings…</p></section>;

  const backfill = store.orderSyncRunning
    ? "In progress — syncing now"
    : store.orderBackfillDone === false
      ? store.orderBackfillCursor ? "In progress — resumes automatically" : "Waiting to start"
      : "Complete";

  return <>
    <section className="panel">
      {back}
      <div className="detail-head">
        <div className="store-info">
          <div className="store-title"><h2>{store.label} settings</h2><span className={`badge ${store.status}`}>{store.status.replace("_", " ")}</span>{store.isActive === false && <span className="badge error">Inactive</span>}</div>
          <p className="muted">{store.country} marketplace · {store.sellerName ?? "Seller profile not loaded"}</p>
        </div>
        <div className="store-actions">
          <button className="secondary" disabled={busy || store.orderSyncRunning || store.isActive === false} onClick={syncNow}>{store.orderSyncRunning ? "Syncing…" : "Sync now"}</button>
          <button className="secondary" disabled={busy || store.orderSyncRunning || store.storeType === "choice" || store.isActive === false} title={store.storeType === "choice" ? "Choice sellers cannot use the Daraz products API" : store.isActive === false ? "Store is inactive" : "Queue a catalog sync for this store"} onClick={syncProducts}>Sync products</button>
          <button className="secondary" disabled={busy || store.orderSyncRunning || store.storeType === "choice" || store.productSyncRunning || store.isActive === false} title={store.storeType === "choice" ? "Choice sellers cannot use the Daraz products API" : store.isActive === false ? "Store is inactive" : "Clear the catalog cursor and re-fetch every product"} onClick={fullResyncProducts}>Full resync</button>
          <button className={store.isActive === false ? "secondary live-on" : "secondary"} disabled={busy} onClick={toggleActive}>{store.isActive === false ? "Activate store" : "Deactivate"}</button>
        </div>
      </div>
    </section>

    <section className="panel">
      <h2>Order sync schedule</h2>
      <p className="muted">Choose how far back Daraz orders are imported for this store and how often the worker checks for changes. Scheduled runs fetch orders <strong>updated since the last update cursor</strong> (minus one minute) so statuses and tracking changes stay current.</p>
      <form className="sync-settings" onSubmit={saveSettings}>
        <label>Sync orders from<input required type="date" name="fromDate" max={new Date().toISOString().slice(0, 10)} defaultValue={store.orderSyncFrom?.slice(0, 10)} /></label>
        <label>Sync frequency<select name="frequency" defaultValue={store.orderSyncFrequency}>
          <option value="manual">Manual only</option>
          <option value="every_15_minutes">Every 15 minutes</option>
          <option value="hourly">Hourly</option>
          <option value="every_6_hours">Every 6 hours</option>
          <option value="daily">Daily</option>
        </select></label>
        <button className="secondary" disabled={busy}>Save settings</button>
      </form>
      {saved && <p className="notice">{saved}</p>}
      <Details rows={[
        ["Last sync", store.orderSyncLastAt ? dateLabel(store.orderSyncLastAt) : "Never"],
        ["Orders updated since", store.orderSyncCursor ? dateLabel(store.orderSyncCursor) : "No update cursor yet"],
        ["Next sync", store.orderSyncNextAt ? dateLabel(store.orderSyncNextAt) : store.orderSyncFrequency === "manual" ? "Manual only" : "Not scheduled"],
        ["Initial backfill", backfill],
        ["Orders synced", (store._count?.orders ?? 0).toLocaleString()],
        ["Products synced", (store._count?.products ?? 0).toLocaleString()],
        ["Last product sync", store.productSyncLastAt ? dateLabel(store.productSyncLastAt) : "Never"],
        ...(store.orderSyncError ? [["Last sync error", store.orderSyncError, "warning"] as [string, ReactNode, string]] : []),
      ]} />
    </section>

    <section className="panel">
      <h2>Seller type</h2>
      <p className="muted">Choice sellers are orders-only here: Daraz handles packing, RTS and AWB printing. Their order details are still synced and available for billing.</p>
      <form className="sync-settings" onSubmit={saveStoreType}>
        <label>Store type<select name="storeType" defaultValue={store.storeType ?? "normal"}>
          <option value="normal">Normal seller — print AWBs here</option>
          <option value="choice">Choice seller — orders only (no AWB actions)</option>
        </select></label>
        <button className="secondary" disabled={busy}>Save seller type</button>
      </form>
      {store.storeType === "choice" && <p className="notice">This store is orders-only. Create package, RTS and AWB actions are hidden for its orders; order details remain available for billing.</p>}
    </section>

    <section className="panel">
      <h2>Product catalog sync</h2>
      {store.storeType === "choice"
        ? <p className="muted">Choice sellers cannot use the Daraz products API. Their SKUs are added automatically from order items.</p>
        : <>
          <p className="muted">Fetches this store's Daraz catalog and every SKU variant (name, image URL, price, offer price, stock). Long catalogs resume automatically across runs.</p>
          <Details rows={[
            ["Status", store.productSyncRunning
              ? "Running now"
              : (store.productSyncOffset ?? 0) > 0
                ? `Initial sync in progress (${store.productSyncOffset?.toLocaleString()} products processed)`
                : "Idle"],
            ["Last product sync", store.productSyncLastAt ? dateLabel(store.productSyncLastAt) : "Never"],
            ["Next product sync", store.productSyncNextAt ? dateLabel(store.productSyncNextAt) : "Not scheduled"],
            ["Products synced", (store._count?.products ?? 0).toLocaleString()],
            ["Variants synced", (store._count?.products ?? 0) > 0 ? "See Products page" : "0"],
            ...(store.productSyncError ? [["Last product sync error", store.productSyncError, "warning"] as [string, ReactNode, string]] : []),
          ]} />
        </>}
    </section>
  </>;
}
function StoreDetail({ token, storeId, admin = false, onBack, onConnect, onRefresh, onRemove, onSettings, onNotice }: {
  token: string; storeId: string; admin?: boolean; onBack: () => void;
  onConnect?: (store: Store) => void; onRefresh?: (store: Store) => Promise<void>; onRemove?: (store: Store) => Promise<void>; onSettings?: () => void; onNotice: (message: string) => void;
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
      <div className="detail-head"><div className="store-avatar">▤</div><div className="store-info"><div className="store-title"><h2>{store.label}</h2><span className={`badge ${store.status}`}>{store.status.replace("_", " ")}</span>{store.verified && <span className="badge connected">Verified</span>}{store.storeType === "choice" && <span className="badge">Choice seller</span>}</div><span className="muted">{store.country} marketplace{store.sellerName ? ` · ${store.sellerName}` : ""}{store.shortCode ? ` · ${store.shortCode}` : ""}</span>{admin && store.user && <small>Owner: {store.user.name} ({store.user.email})</small>}</div>
        {!admin && <div className="store-actions"><button className="secondary" onClick={() => onConnect?.(store)}>{connectLabel(store)}</button><button className="text-button" disabled={busy || !store.refreshExpiresAt || refreshDays !== null && refreshDays <= 0} onClick={refreshToken}>Get new access token</button><button className="text-button" disabled={busy || !accessValid} title={accessValid ? "Fetch the latest seller profile from Daraz" : "Requires a valid access token"} onClick={refreshProfile}>Refresh details</button><button className="text-button" onClick={onSettings}>Sync settings</button><button className="remove-button" onClick={() => onRemove?.(store)}>Remove</button></div>}
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

type DashboardStats = {
  range: { days: number; from: string; storeId: string | null };
  totals: { sales: number; orders: number; paidOrders: number; products: number; variants: number; stores: number; connected: number; units: number; aov: number; unitsPerOrder: number };
  previous: { sales: number; paidOrders: number; orders: number; units: number; aov: number };
  comparison: { salesPct: number | null; ordersPct: number | null; aovPct: number | null; unitsPct: number | null };
  windows: { today: number; last7: number };
  trend: { days: number; points: Array<{ date: string; total: number; byStore?: Record<string, number> }> };
  orderTrend: { days: number; points: Array<{ date: string; total: number; byStore?: Record<string, number> }> };
  statusTrend: Array<{ date: string; orders: number; canceled: number; returned: number }>;
  ordersByGroup: Record<string, number>;
  stores: Array<{
    id: string; label: string; country: string; storeType: string; status: string;
    orders: number; paidOrders: number; sales: number; previousSales: number; salesDeltaPct: number | null; salesShare: number;
    canceled: number; returned: number; products: number; variants: number;
    lastOrderSyncAt: string | null; lastProductSyncAt: string | null;
    orderSyncError: string | null; productSyncError: string | null;
    syncHealth: { score: number; lastOrderAgeHours: number | null };
    rank: number; previousRank: number;
  }>;
  storeOptions: Array<{ id: string; label: string }>;
  topProducts: Array<{ itemId: string; name: string | null; sku: string | null; imageUrl: string | null; revenue: number; units: number }>;
  categories: Array<{ category: string; revenue: number; units: number; share: number }>;
  stock: {
    outOfStock: number; lowStock: number; deadStock: number;
    lowStockVariants: Array<{ id: string; sku: string; quantity: number; name: string | null; storeLabel: string }>;
    deadProducts: Array<{ id: string; sku: string; quantity: number; name: string | null; storeLabel: string }>;
  };
  heatmap: Array<{ dow: number; hour: number; revenue: number; orders: number }>;
  recentActivity: Array<{ id: string; action: string; meta: any; createdAt: string; storeLabel: string | null }>;
  generatedAt: string;
};

const shortNumber = (value: number) => {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${Math.round(value)}`;
};

const formatCompact = (value: number) => Number.isFinite(value) ? `NPR ${shortNumber(value)}` : "—";

const STORE_COLORS = ["#ee5a24", "#2f62b5", "#21835f", "#a8710e", "#6a4bc4", "#c94f44", "#1c7aa8", "#8b6c42", "#d1478a", "#3f7f6f"];

function SalesLineChart({ points, stores, hidden, showTotal }: {
  points: Array<{ date: string; total: number; byStore?: Record<string, number> }>;
  stores: DashboardStats["stores"];
  hidden: Set<string>;
  showTotal: boolean;
}) {
  const width = 760;
  const height = 240;
  const pad = { top: 14, right: 16, bottom: 30, left: 56 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;

  const series = stores
    .map((store, index) => ({
      id: store.id,
      label: store.label,
      color: STORE_COLORS[index % STORE_COLORS.length],
      values: points.map((point) => Number(point.byStore?.[store.id] ?? 0)),
    }))
    .filter((entry) => !hidden.has(entry.id));
  if (showTotal) {
    series.push({ id: "__total", label: "Total", color: "#20252d", values: points.map((point) => point.total) });
  }

  const max = Math.max(1, ...series.flatMap((entry) => entry.values));
  const x = (index: number) => pad.left + (points.length <= 1 ? 0 : (innerWidth * index) / (points.length - 1));
  const y = (value: number) => pad.top + innerHeight * (1 - value / max);
  const grid = [0, 0.25, 0.5, 0.75, 1];
  const labelStep = Math.max(1, Math.ceil(points.length / 6));

  return <svg className="line-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Sales trend by store">
    {grid.map((fraction) => <g key={fraction}>
      <line x1={pad.left} x2={width - pad.right} y1={pad.top + innerHeight * fraction} y2={pad.top + innerHeight * fraction} stroke="#eef0f2" />
      <text x={pad.left - 8} y={pad.top + innerHeight * fraction + 4} textAnchor="end" fontSize="10" fill="#9aa1a9">{shortNumber(max * (1 - fraction))}</text>
    </g>)}
    {series.map((entry) => {
      const line = entry.values.map((value, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
      return <g key={entry.id}>
        <path d={line} fill="none" stroke={entry.color} strokeWidth={entry.id === "__total" ? 2.5 : 2} strokeDasharray={entry.id === "__total" ? "6 4" : undefined} strokeLinejoin="round" strokeLinecap="round" />
        {points.length <= 31 && entry.values.map((value, index) => value > 0
          ? <circle key={`${entry.id}-${points[index].date}`} cx={x(index)} cy={y(value)} r="2.6" fill="#fff" stroke={entry.color} strokeWidth="1.8">
            <title>{`${entry.label} · ${points[index].date}: ${formatMoney(value)}`}</title>
          </circle>
          : null)}
      </g>;
    })}
    {points.map((point, index) => index % labelStep === 0 || index === points.length - 1
      ? <text key={`label-${point.date}`} x={x(index)} y={height - 8} textAnchor="middle" fontSize="9" fill="#9aa1a9">{point.date.slice(5)}</text>
      : null)}
  </svg>;
}

function OrdersLineChart({ points, stores, hidden, showTotal }: {
  points: Array<{ date: string; total: number; byStore?: Record<string, number> }>;
  stores: DashboardStats["stores"];
  hidden: Set<string>;
  showTotal: boolean;
}) {
  const width = 760;
  const height = 220;
  const pad = { top: 14, right: 16, bottom: 30, left: 44 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const series = stores
    .map((store, index) => ({
      id: store.id,
      label: store.label,
      color: STORE_COLORS[index % STORE_COLORS.length],
      values: points.map((point) => Number(point.byStore?.[store.id] ?? 0)),
    }))
    .filter((entry) => !hidden.has(entry.id));
  if (showTotal) series.push({ id: "__total", label: "Total", color: "#20252d", values: points.map((point) => point.total) });

  const max = Math.max(1, ...series.flatMap((entry) => entry.values));
  const x = (index: number) => pad.left + (points.length <= 1 ? 0 : (innerWidth * index) / (points.length - 1));
  const y = (value: number) => pad.top + innerHeight * (1 - value / max);
  const grid = [0, 0.25, 0.5, 0.75, 1];
  const labelStep = Math.max(1, Math.ceil(points.length / 6));

  return <svg className="line-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Orders per day by store">
    {grid.map((fraction) => <g key={fraction}>
      <line x1={pad.left} x2={width - pad.right} y1={pad.top + innerHeight * fraction} y2={pad.top + innerHeight * fraction} stroke="#eef0f2" />
      <text x={pad.left - 8} y={pad.top + innerHeight * fraction + 4} textAnchor="end" fontSize="10" fill="#9aa1a9">{Math.round(max * (1 - fraction))}</text>
    </g>)}
    {series.map((entry) => {
      const line = entry.values.map((value, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
      return <g key={entry.id}>
        <path d={line} fill="none" stroke={entry.color} strokeWidth={entry.id === "__total" ? 2.5 : 2} strokeDasharray={entry.id === "__total" ? "6 4" : undefined} strokeLinejoin="round" strokeLinecap="round" />
        {points.length <= 31 && entry.values.map((value, index) => value > 0
          ? <circle key={`${entry.id}-${points[index].date}`} cx={x(index)} cy={y(value)} r="2.6" fill="#fff" stroke={entry.color} strokeWidth="1.8">
            <title>{`${entry.label} · ${points[index].date}: ${value.toLocaleString()} orders`}</title>
          </circle>
          : null)}
      </g>;
    })}
    {points.map((point, index) => index % labelStep === 0 || index === points.length - 1
      ? <text key={`orders-${point.date}`} x={x(index)} y={height - 8} textAnchor="middle" fontSize="9" fill="#9aa1a9">{point.date.slice(5)}</text>
      : null)}
  </svg>;
}

function StoreSalesBars({ stores }: { stores: DashboardStats["stores"] }) {
  const sorted = [...stores].sort((first, second) => second.sales - first.sales);
  const max = Math.max(1, ...sorted.map((store) => store.sales));
  if (!sorted.length) return <p className="muted">No stores yet.</p>;
  return <div className="bar-list">{sorted.map((store) => <div className="bar-row" key={store.id}>
    <span className="bar-label" title={store.label}>{store.label}</span>
    <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.max(store.sales > 0 ? 3 : 0, (store.sales / max) * 100)}%` }} /></div>
    <span className="bar-value">{formatCompact(store.sales)} · {store.salesShare}%</span>
  </div>)}</div>;
}

function DeltaBadge({ value }: { value: number | null }) {
  if (value === null) return <span className="delta flat">no prior period</span>;
  return <span className={`delta ${value >= 0 ? "up" : "down"}`}>{value >= 0 ? "▲" : "▼"} {Math.abs(value).toFixed(1)}% vs prev</span>;
}

function HealthBadge({ score }: { score: number }) {
  return <span className={`health ${score >= 80 ? "ok" : score >= 60 ? "warn" : "bad"}`} title={`Sync health score ${score}/100`}>{score}</span>;
}

function CategoryBars({ categories }: { categories: DashboardStats["categories"] }) {
  const max = Math.max(1, ...categories.map((category) => category.revenue));
  if (!categories.length) return <p className="muted">No category data yet (needs cached order line items).</p>;
  return <div className="bar-list">{categories.map((category) => <div className="bar-row" key={category.category}>
    <span className="bar-label" title={category.category}>{category.category}</span>
    <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.max(3, (category.revenue / max) * 100)}%` }} /></div>
    <span className="bar-value">{formatCompact(category.revenue)} · {category.share.toFixed(0)}%</span>
  </div>)}</div>;
}

function StatusTrendChart({ points }: { points: DashboardStats["statusTrend"] }) {
  const width = 520;
  const height = 150;
  const pad = { top: 10, right: 10, bottom: 22, left: 30 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const max = Math.max(1, ...points.map((point) => point.returned));
  const x = (index: number) => pad.left + (points.length <= 1 ? 0 : (innerWidth * index) / (points.length - 1));
  const y = (value: number) => pad.top + innerHeight * (1 - value / max);
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(point.returned).toFixed(1)}`).join(" ");
  return <svg className="mini-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Returned orders">
    <line x1={pad.left} x2={width - pad.right} y1={pad.top + innerHeight} y2={pad.top + innerHeight} stroke="#eef0f2" />
    <path d={line} fill="none" stroke="#6a4bc4" strokeWidth="2" />
    {points.map((point, index) => <circle key={point.date} cx={x(index)} cy={y(point.returned)} r="2" fill="#6a4bc4"><title>{`${point.date} · returned ${point.returned}`}</title></circle>)}
  </svg>;
}

function SalesHeatmap({ cells }: { cells: DashboardStats["heatmap"] }) {
  const lookup = new Map(cells.map((cell) => [`${cell.dow}-${cell.hour}`, cell]));
  const max = Math.max(1, ...cells.map((cell) => cell.revenue));
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return <div className="heatmap">
    <div className="heat-hours"><span />{Array.from({ length: 24 }, (_, hour) => <span key={hour}>{hour % 3 === 0 ? hour : ""}</span>)}</div>
    {days.map((day, dow) => <div className="heat-row" key={day}>
      <span className="heat-day">{day}</span>
      {Array.from({ length: 24 }, (_, hour) => {
        const cell = lookup.get(`${dow}-${hour}`);
        const strength = cell ? Math.max(0.08, cell.revenue / max) : 0;
        return <span
          key={hour}
          className={cell ? "heat-cell" : "heat-cell empty"}
          style={cell ? { background: `rgba(238,90,36,${strength.toFixed(2)})` } : undefined}
          title={cell ? `${day} ${hour}:00 · NPR ${Math.round(cell.revenue).toLocaleString()} · ${cell.orders} orders` : "No paid orders"}
        />;
      })}
    </div>)}
  </div>;
}

function Dashboard({ token, onOpenStore, onManageStores }: { token: string; onOpenStore: (store: { id: string }) => void; onManageStores: () => void }) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [days, setDays] = useState(14);
  const [storeId, setStoreId] = useState("");
  const [live, setLive] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");
  const [hiddenStores, setHiddenStores] = useState<Set<string>>(new Set());
  const [showTotal, setShowTotal] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncNote, setSyncNote] = useState("");

  const toggleStoreSeries = (id: string) => setHiddenStores((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const load = useCallback(async () => {
    try {
      const data = await api(`/dashboard/stats?days=${days}${storeId ? `&storeId=${storeId}` : ""}`, token);
      setStats(data);
      setUpdatedAt(new Date().toLocaleTimeString());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load dashboard stats.");
    } finally {
      setLoading(false);
    }
  }, [token, days, storeId]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => { void load(); }, 30_000);
    return () => clearInterval(timer);
  }, [live, load]);

  async function syncOrdersNow() {
    if (!storeId) return;
    setSyncBusy(true);
    setSyncNote("Queueing…");
    let finished = false;
    try {
      const before = await api(`/stores/${storeId}`, token);
      const beforeCount = before._count?.orders ?? 0;
      const beforeLast = before.orderSyncLastAt ?? null;
      await api(`/stores/${storeId}/orders/sync`, token, { method: "POST" });
      setSyncNote("Syncing…");
      for (let attempt = 0; attempt < 45; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const current = await api(`/stores/${storeId}`, token);
        if (current.orderSyncError) {
          setSyncNote(`Sync error: ${String(current.orderSyncError).slice(0, 140)}`);
          finished = true;
          break;
        }
        if (current.orderSyncLastAt && current.orderSyncLastAt !== beforeLast && !current.orderSyncRunning) {
          const afterCount = current._count?.orders ?? 0;
          const delta = afterCount - beforeCount;
          setSyncNote(`${Math.max(delta, 0).toLocaleString()} new orders synced · ${afterCount.toLocaleString()} total`);
          await load();
          finished = true;
          break;
        }
        setSyncNote(`Syncing… ${(attempt + 1) * 2}s`);
      }
      if (!finished) setSyncNote("Still syncing — check Administration → Store logs.");
    } catch (e) {
      setSyncNote(e instanceof Error ? e.message : "Unable to sync orders.");
    } finally {
      setSyncBusy(false);
    }
  }

  async function exportCsv() {
    try {
      const response = await fetch(`/api/dashboard/export?days=${days}${storeId ? `&storeId=${storeId}` : ""}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("Export failed.");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `daraz-report-${storeId ? "store" : "all-stores"}-${days}d.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    }
  }

  if (error) return <section className="panel"><p className="notice error">{error}</p><button className="secondary" onClick={() => void load()}>Retry</button></section>;
  if (!stats) return <section className="panel"><p className="muted">{loading ? "Loading dashboard…" : "No dashboard data."}</p></section>;

  const { totals, comparison, windows, ordersByGroup, stock } = stats;
  const selectedStore = stats.stores.length === 1 && storeId ? stats.stores[0] : null;
  const scopeLabel = selectedStore ? selectedStore.label : "All stores";
  const unpaid = ordersByGroup.unpaid ?? 0;
  const toShip = ordersByGroup.to_ship ?? 0;
  const shipping = ordersByGroup.shipping ?? 0;

  return <>
    <div className="dash-toolbar">
      <div className="head-actions">
        <select value={storeId} onChange={(event) => setStoreId(event.target.value)} aria-label="Dashboard store">
          <option value="">All stores</option>
          {stats.storeOptions.map((store) => <option key={store.id} value={store.id}>{store.label}</option>)}
        </select>
        <select value={days} onChange={(event) => setDays(Number(event.target.value))} aria-label="Dashboard range">
          <option value={7}>Last 7 days</option>
          <option value={14}>Last 14 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
        <button className={live ? "secondary live-on" : "secondary"} onClick={() => setLive((value) => !value)}><span className={live ? "dot" : "dot offline"} /> {live ? "Live" : "Paused"}</button>
        <button className="secondary" onClick={() => void load()}>Refresh</button>
        <button className="secondary" disabled={!storeId || syncBusy} title={!storeId ? "Select a store to sync its orders" : "Run an order sync now"} onClick={() => void syncOrdersNow()}>{syncBusy ? "Syncing…" : "Sync orders"}</button>
        <button className="secondary" onClick={() => void exportCsv()}>Export CSV</button>
      </div>
      <span className="dash-updated">{scopeLabel} · last {days} days · updated {updatedAt}{live ? " · refreshes every 30s" : ""}{syncNote && <span className="sync-note"> · {syncNote}</span>}</span>
    </div>

    <div className="stat-grid">
      <article className="stat-card"><div className="stat-head"><span>Net sales</span><span className="stat-icon icon-0">₨</span></div><strong>{formatCompact(totals.sales)}</strong><DeltaBadge value={comparison.salesPct} /><small>Paid orders · today {formatCompact(windows.today)}</small></article>
      <article className="stat-card"><div className="stat-head"><span>Orders</span><span className="stat-icon icon-1">▣</span></div><strong>{totals.orders.toLocaleString()}</strong><DeltaBadge value={comparison.ordersPct} /><small>Unpaid {unpaid.toLocaleString()} · To Ship {toShip.toLocaleString()} · Shipping {shipping.toLocaleString()}</small></article>
      <article className="stat-card"><div className="stat-head"><span>AOV</span><span className="stat-icon icon-2">≈</span></div><strong>{formatMoney(totals.aov)}</strong><DeltaBadge value={comparison.aovPct} /><small>{totals.unitsPerOrder} units/order · {totals.units.toLocaleString()} units</small></article>
      <article className="stat-card"><div className="stat-head"><span>SKUs</span><span className="stat-icon icon-3">▦</span></div><strong>{(totals.products + totals.variants).toLocaleString()}</strong><small>{totals.products.toLocaleString()} products · {totals.variants.toLocaleString()} variants (current)</small></article>
    </div>

    <section className="panel">
      <div className="section-head"><div><h2>Orders by status</h2><p className="muted">Daraz order statuses · {scopeLabel} · last {days} days</p></div></div>
      <div className="status-summary">
        {[["unpaid", "Unpaid"], ["to_ship", "To Ship"], ["shipping", "Shipping"], ["delivered", "Delivered"], ["failed_delivery", "Failed Delivery"], ["returned", "Return or Refund"]].map(([key, label]) => <div className="status-cell" key={key}>
          <span className={`badge ${key}`}>{label}</span>
          <strong>{(ordersByGroup[key] ?? 0).toLocaleString()}</strong>
        </div>)}
      </div>
    </section>

    <div className="dash-panels">
      <section className="panel">
        <div className="chart-head">
          <div><h2>Sales trend</h2><p className="muted">Paid sales per store · {scopeLabel} · last {days} days · click a legend item to hide/show</p></div>
        </div>
        <div className="chart-legend">
          {stats.stores.map((store, index) => <button key={store.id} type="button" className={`legend-item ${hiddenStores.has(store.id) ? "off" : ""}`} onClick={() => toggleStoreSeries(store.id)} title={`Toggle ${store.label}`}>
            <span className="legend-swatch" style={{ background: STORE_COLORS[index % STORE_COLORS.length] }} />{store.label}
          </button>)}
          <button type="button" className={`legend-item ${showTotal ? "" : "off"}`} onClick={() => setShowTotal((value) => !value)} title="Toggle total line">
            <span className="legend-swatch" style={{ background: "#20252d" }} />Total
          </button>
        </div>
        <SalesLineChart points={stats.trend.points} stores={stats.stores} hidden={hiddenStores} showTotal={showTotal} />
      </section>

      <section className="panel">
        <div className="chart-head"><div><h2>Sales by store</h2><p className="muted">Paid sales · last {days} days</p></div></div>
        <StoreSalesBars stores={stats.stores} />
      </section>
    </div>

    <section className="panel">
      <div className="chart-head">
        <div><h2>Orders per day</h2><p className="muted">Non-canceled orders per store · {scopeLabel} · last {days} days · click a legend item to hide/show</p></div>
      </div>
      <div className="chart-legend">
        {stats.stores.map((store, index) => <button key={store.id} type="button" className={`legend-item ${hiddenStores.has(store.id) ? "off" : ""}`} onClick={() => toggleStoreSeries(store.id)} title={`Toggle ${store.label}`}>
          <span className="legend-swatch" style={{ background: STORE_COLORS[index % STORE_COLORS.length] }} />{store.label}
        </button>)}
        <button type="button" className={`legend-item ${showTotal ? "" : "off"}`} onClick={() => setShowTotal((value) => !value)} title="Toggle total line">
          <span className="legend-swatch" style={{ background: "#20252d" }} />Total
        </button>
      </div>
      <OrdersLineChart points={stats.orderTrend.points} stores={stats.stores} hidden={hiddenStores} showTotal={showTotal} />
    </section>

    <div className="dash-panels">
      <section className="panel">
        <div className="chart-head"><div><h2>Top products</h2><p className="muted">Revenue and units from cached order line items</p></div></div>
        {stats.topProducts.length === 0
          ? <p className="muted">No product-level sales yet — open or sync orders to cache their line items.</p>
          : <div className="table-wrap"><table>
            <thead><tr><th>Product</th><th>SKU</th><th>Units</th><th>Revenue</th></tr></thead>
            <tbody>{stats.topProducts.map((product) => <tr key={product.itemId}>
              <td><div className="product-cell">{product.imageUrl ? <img className="product-thumb" src={product.imageUrl} alt="" loading="lazy" /> : <span className="product-thumb placeholder" />}<span>{product.name ?? product.itemId}</span></div></td>
              <td className="muted">{product.sku ?? "—"}</td>
              <td>{product.units.toLocaleString()}</td>
              <td className="money">{formatMoney(product.revenue)}</td>
            </tr>)}</tbody></table></div>}
      </section>

      <section className="panel">
        <div className="chart-head"><div><h2>Categories</h2><p className="muted">Revenue share from product categories</p></div></div>
        <CategoryBars categories={stats.categories} />
      </section>
    </div>

    <div className="dash-panels">
      <section className="panel">
        <div className="chart-head"><div><h2>Returns</h2><p className="muted">Daily returned orders · last {days} days</p></div><div className="head-actions"><span className="legend-item"><span className="legend-swatch" style={{ background: "#6a4bc4" }} />Returned</span></div></div>
        <StatusTrendChart points={stats.statusTrend} />
        <p className="muted">Return rate {totals.orders ? (((ordersByGroup.returned ?? 0) / totals.orders) * 100).toFixed(1) : "0"}% · canceled orders are excluded from all metrics.</p>
      </section>

      <section className="panel">
        <div className="chart-head"><div><h2>Stock alerts</h2><p className="muted">Current catalog · all selected stores</p></div></div>
        <div className="stock-cards">
          <div className="stock-card bad"><strong>{stock.outOfStock.toLocaleString()}</strong><span>out of stock</span></div>
          <div className="stock-card warn"><strong>{stock.lowStock.toLocaleString()}</strong><span>low stock (≤5)</span></div>
          <div className="stock-card"><strong>{stock.deadStock.toLocaleString()}</strong><span>no sales in range</span></div>
        </div>
        {stock.lowStockVariants.length > 0 && <div className="stock-list">{stock.lowStockVariants.map((variant) => <div className="stock-row" key={variant.id}>
          <span>{variant.name ?? variant.sku}<small>{variant.storeLabel} · {variant.sku}</small></span>
          <strong>{variant.quantity}</strong>
        </div>)}</div>}
      </section>
    </div>

    <section className="panel">
      <div className="chart-head"><div><h2>Sales heatmap</h2><p className="muted">Paid sales by weekday and hour (UTC) · last {days} days</p></div></div>
      <SalesHeatmap cells={stats.heatmap} />
    </section>

    <section className="panel">
      <div className="section-head">
        <div><h2>Store leaderboard</h2><p className="muted">Ranked by sales in the selected range; share and change vs the previous period.</p></div>
        <button className="secondary" onClick={onManageStores}>Manage stores</button>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Rank</th><th>Store</th><th>Sales</th><th>Share</th><th>Change</th><th>Orders</th><th>Returned</th><th>SKUs</th><th>Sync health</th><th>Last order sync</th></tr></thead>
        <tbody>{stats.stores.map((store) => {
          const movement = store.previousRank - store.rank;
          return <tr key={store.id} className="order-row" onClick={() => onOpenStore(store)}>
            <td><span className="rank">{store.rank}{movement > 0 ? " ▲" : movement < 0 ? " ▼" : ""}</span></td>
            <td><button className="link-button" onClick={(event) => { event.stopPropagation(); onOpenStore(store); }}>{store.label}</button><small>{store.country}{store.storeType === "choice" ? " · Choice seller" : ""}</small></td>
            <td className="money">{formatMoney(store.sales)}</td>
            <td>{store.salesShare}%</td>
            <td><DeltaBadge value={store.salesDeltaPct} /></td>
            <td>{store.orders.toLocaleString()}</td>
            <td>{store.returned.toLocaleString()}</td>
            <td>{store.products.toLocaleString()} / {store.variants.toLocaleString()}</td>
            <td><HealthBadge score={store.syncHealth.score} />{store.orderSyncError ? <span className="warning" title={store.orderSyncError}> !</span> : null}</td>
            <td>{store.lastOrderSyncAt ? dateLabel(store.lastOrderSyncAt) : "Never"}</td>
          </tr>;
        })}</tbody></table></div>
    </section>
  </>;
}

type OrderRow = {
  id: string; storeId: string; darazOrderId: string; customerName: string | null;
  orderCreatedAt: string; orderUpdatedAt: string | null; orderStatus: string | null; statusGroup: string | null;
  deliveryStatus: string | null; trackingNumber: string | null; amount: string | null; itemCount: number | null;
  store: { label: string; country: string; storeType?: string };
};
type OrderSummary = { groups: Record<string, number>; toShip?: Record<string, number> };

const ORDER_TABS: Array<{ key: string; label: string }> = [
  { key: "", label: "All" },
  { key: "unpaid", label: "Unpaid" },
  { key: "to_ship", label: "To Ship" },
  { key: "shipping", label: "Shipping" },
  { key: "delivered", label: "Delivered" },
  { key: "failed_delivery", label: "Failed Delivery" },
  { key: "canceled", label: "Cancellation" },
  { key: "returned", label: "Return or Refund" },
];

const formatMoney = (value: string | number | null | undefined) => {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number) ? `NPR ${number.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—";
};

function StatusBadge({ group }: { group?: string | null }) {
  return <span className={`badge ${group ?? "unknown"}`}>{(group ?? "unknown").replaceAll("_", " ")}</span>;
}

function OrderStatusBadge({ order }: { order: OrderRow }) {
  const raw = (order.orderStatus ?? "").toLowerCase();
  if (order.statusGroup === "unpaid" && raw.includes("pending")) return <span className="badge to_ship">To Pack</span>;
  if (order.statusGroup === "to_ship" && raw.includes("packed")) return <span className="badge to_ship">To Arrange Shipment</span>;
  if (order.statusGroup === "to_ship" && raw.includes("ready_to_ship")) return <span className="badge to_ship">To Handover</span>;
  return <StatusBadge group={order.statusGroup} />;
}

function Orders({ token, stores }: { token: string; stores: Store[] }) {
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [summary, setSummary] = useState<OrderSummary | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [total, setTotal] = useState<number | null>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [hasNext, setHasNext] = useState(false);
  const [storeId, setStoreId] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusGroup, setStatusGroup] = useState("");
  const [orderStatus, setOrderStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState("updatedAt:desc");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<OrderRow | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [moreMenu, setMoreMenu] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [actionNotice, setActionNotice] = useState("");
  const [noteVersion, setNoteVersion] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 350);
    return () => clearTimeout(timer);
  }, [search]);

  const [sortBy, sortOrder] = sort.split(":") as [string, "asc" | "desc"];

  useEffect(() => {
    if (!token) return;
    const filters = new URLSearchParams();
    if (storeId) filters.set("storeId", storeId);
    if (debouncedSearch) filters.set("search", debouncedSearch);
    if (from) filters.set("from", from);
    if (to) filters.set("to", to);

    const list = new URLSearchParams(filters);
    list.set("page", String(page));
    list.set("pageSize", String(pageSize));
    list.set("sortBy", sortBy);
    list.set("sortOrder", sortOrder);
    if (statusGroup) list.set("statusGroup", statusGroup);
    if (orderStatus) list.set("orderStatus", orderStatus);

    let current = true;
    setLoading(true);
    api(`/orders?${list}`, token)
      .then((data) => {
        if (!current) return;
        setRows(data.orders);
        setTotal(data.total);
        setTotalPages(data.totalPages ?? 0);
        setHasNext(Boolean(data.hasNext) || (typeof data.total === "number" && data.page < data.totalPages));
        setError("");
        setLoading(false);
      })
      .catch((e) => {
        if (!current) return;
        setError(e instanceof Error ? e.message : "Unable to load orders.");
        setLoading(false);
      });
    api(`/orders/summary?${filters}`, token)
      .then((summaryData) => { if (current) setSummary(summaryData); })
      .catch(() => { if (current) setSummary({ groups: {} }); });
    return () => { current = false; };
  }, [token, page, pageSize, storeId, debouncedSearch, from, to, sortBy, sortOrder, statusGroup, orderStatus, reloadKey]);

  const counts = summary?.groups ?? {};
  const pageText = total === null
    ? `${rows.length} orders on this page`
    : total === 0
      ? "0 orders"
      : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total.toLocaleString()}`;

  async function exportCsv() {
    const filters = new URLSearchParams();
    if (storeId) filters.set("storeId", storeId);
    if (debouncedSearch) filters.set("search", debouncedSearch);
    if (from) filters.set("from", from);
    if (to) filters.set("to", to);
    if (statusGroup) filters.set("statusGroup", statusGroup);
    if (orderStatus) filters.set("orderStatus", orderStatus);
    try {
      const response = await fetch(`/api/orders/export?${filters}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Export failed.");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `daraz-orders-${new Date().toISOString().slice(0, 10)}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    }
  }

  const selectedOrders = rows.filter((order) => selectedIds.has(order.id));
  const escapeHtml = (value: unknown) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const canFulfil = (order: OrderRow) => order.store.storeType !== "choice" && !["canceled", "delivered", "returned", "failed_delivery"].includes(order.statusGroup ?? "");

  async function orderDetail(order: OrderRow): Promise<any> {
    try {
      return await api(`/orders/${order.id}`, token);
    } catch {
      return null;
    }
  }

  async function printOrders(orders: OrderRow[], kind: "picklist" | "invoice") {
    if (!orders.length) return;
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      setActionNotice("Allow pop-ups to print picklists/invoices.");
      return;
    }
    printWindow.document.write("<p style='font-family:sans-serif;padding:24px'>Preparing printout…</p>");
    const blocks: string[] = [];
    for (const order of orders) {
      const detail = await orderDetail(order);
      const data = detail?.rawDetails?.data ?? {};
      const items: any[] = Array.isArray(data.order_items) ? data.order_items : [];
      const address = data.address_shipping ?? {};
      const rowsHtml = items.length
        ? items.map((item) => `<tr><td>${escapeHtml(item.name ?? item.shop_sku ?? item.sku)}<br><small>SKU ${escapeHtml(item.shop_sku ?? item.sku ?? "—")}</small></td><td>${escapeHtml(item.quantity ?? 1)}</td><td>${escapeHtml(formatMoney(item.paid_price))}</td></tr>`).join("")
        : `<tr><td colspan="3">No cached line items</td></tr>`;
      blocks.push(`<section class="block">
        <header><strong>${kind === "picklist" ? "PICKLIST" : "INVOICE"}</strong><span>${escapeHtml(order.store.label)} · ${escapeHtml(order.darazOrderId)}</span></header>
        <div class="meta"><div><b>Customer</b><br>${escapeHtml(order.customerName ?? "—")}</div><div><b>Created</b><br>${escapeHtml(dateLabel(order.orderCreatedAt))}</div><div><b>Amount</b><br>${escapeHtml(formatMoney(order.amount))}</div><div><b>Tracking</b><br>${escapeHtml(order.trackingNumber ?? "—")}</div></div>
        <table><thead><tr><th>Item</th><th>Qty</th><th>Price</th></tr></thead><tbody>${rowsHtml}</tbody></table>
        <address>${escapeHtml([address.address1, address.address2, address.address3, address.city, address.country].filter(Boolean).join(", ") || "—")}<br>${escapeHtml(address.phone ?? "")}</address>
      </section>`);
    }
    printWindow.document.open();
    printWindow.document.write(`<!doctype html><html><head><title>${kind === "picklist" ? "Picklist" : "Invoice"}</title><style>
      body{font-family:Roboto,Arial,sans-serif;color:#20252d;padding:24px;font-size:12px}
      .block{border:1px solid #ddd;border-radius:8px;padding:16px;margin-bottom:16px;page-break-inside:avoid}
      header{display:flex;justify-content:space-between;border-bottom:1px solid #eee;padding-bottom:8px;margin-bottom:10px}
      .meta{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px}
      table{width:100%;border-collapse:collapse;margin-bottom:8px}
      th,td{text-align:left;border-bottom:1px solid #eee;padding:6px}
      address{color:#555;font-style:normal}
    </style></head><body>${blocks.join("")}</body></html>`);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  }

  async function packAndPrint(order: OrderRow) {
    if (!canFulfil(order)) {
      setActionNotice(`Order ${order.darazOrderId} cannot be packed in its current state.`);
      return;
    }
    setBulkBusy(true);
    setActionNotice(`Packing ${order.darazOrderId}…`);
    try {
      const detail = await orderDetail(order);
      const items: any[] = Array.isArray(detail?.rawDetails?.data?.order_items) ? detail.rawDetails.data.order_items : [];
      const hasPackage = items.some((item) => item.package_id) || Boolean(order.trackingNumber);
      if (!hasPackage) await api(`/orders/${order.id}/package`, token, { method: "POST" });
      const awb = await api(`/orders/${order.id}/awb`, token);
      if (awb.pdfUrl) window.open(awb.pdfUrl, "_blank", "noopener,noreferrer");
      setActionNotice(hasPackage ? `AWB opened for ${order.darazOrderId}.` : `Package created and AWB opened for ${order.darazOrderId}.`);
      setReloadKey((key) => key + 1);
    } catch (e) {
      setActionNotice(e instanceof Error ? e.message : "Pack & Print failed.");
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkPackAndPrint() {
    for (const order of selectedOrders) {
      if (!canFulfil(order)) continue;
      await packAndPrint(order);
    }
  }

  function sellerNote(order: OrderRow) {
    const key = `daraz-hub-note:${order.id}`;
    const next = prompt(`Seller note for ${order.darazOrderId}`, localStorage.getItem(key) ?? "");
    if (next === null) return;
    if (next.trim()) localStorage.setItem(key, next.trim());
    else localStorage.removeItem(key);
    setNoteVersion((value) => value + 1);
    setMoreMenu(null);
  }

  function toggleAll() {
    setSelectedIds(selectedIds.size === rows.length ? new Set() : new Set(rows.map((order) => order.id)));
  }

  async function copyOrderNumber(order: OrderRow) {
    try {
      await navigator.clipboard.writeText(order.darazOrderId);
      setActionNotice(`Order number ${order.darazOrderId} copied.`);
    } catch {
      setActionNotice(`Order number: ${order.darazOrderId}`);
    }
  }

  async function generateInvoice(order: OrderRow) {
    if (!order.trackingNumber) {
      setActionNotice("A tracking number is required before generating a tax invoice.");
      return;
    }
    if (!confirm(`Generate & print the IMS tax invoice?\n\nOrder: ${order.darazOrderId}\nTracking: ${order.trackingNumber}\nCustomer: ${order.customerName ?? "—"}\nAmount: ${formatMoney(order.amount)}\n\nOnly one IMS invoice is allowed per tracking number.`)) return;
    setBulkBusy(true);
    setActionNotice("Generating IMS tax invoice…");
    try {
      const result = await api("/ims/invoices/generate", token, { method: "POST", body: JSON.stringify({ orderId: order.id, confirm: true }) });
      const invoice = result.invoice;
      setActionNotice(result.existing ? `Invoice ${invoice.imsInvoiceNumber ?? "already exists"} for this tracking number.` : `IMS invoice ${invoice.imsInvoiceNumber ?? "created"} · ${String(invoice.status).replaceAll("_", " ")}`);
      if (invoice.pdfPath) await imsPdf(token, invoice.id, false).catch(() => {});
    } catch (e) {
      setActionNotice(e instanceof Error ? e.message : "Invoice generation failed.");
    } finally {
      setBulkBusy(false);
      setMoreMenu(null);
    }
  }

  return <>
    <section className="panel">
      <div className="section-head">
        <div><h2>Orders {storeId && total !== null && <span className="count">{total.toLocaleString()}</span>}</h2><p className="muted">All connected stores in one queue, with the same status lanes as Seller Center.</p></div>
        <div className="head-actions">
          <button className="secondary" disabled={loading} onClick={() => setReloadKey((key) => key + 1)}>Refresh</button>
          <button className="secondary" onClick={() => void exportCsv()}>Export CSV</button>
        </div>
      </div>

      <div className="status-tabs" role="tablist">
        {ORDER_TABS.map((tab) => {
          const count = storeId && ["unpaid", "to_ship", "shipping"].includes(tab.key) ? counts[tab.key] ?? 0 : null;
          return <button key={tab.key || "all"} role="tab" aria-selected={statusGroup === tab.key} className={statusGroup === tab.key ? "status-tab active" : "status-tab"} onClick={() => { setStatusGroup(tab.key); setOrderStatus(""); setPage(1); }}>
            {tab.label}{count !== null && count > 0 && <span className="tab-count">{count.toLocaleString()}</span>}
          </button>;
        })}
      </div>

      {statusGroup === "to_ship" && <div className="substatus-row">
        {[["", "All"], ["to_pack", "To Pack"], ["to_arrange", "To Arrange Shipment"], ["to_handover", "To Handover"]].map(([key, label]) => {
          const count = storeId && summary?.toShip ? (key ? summary.toShip[key] ?? 0 : counts.to_ship ?? 0) : null;
          return <button key={key || "all"} className={orderStatus === key ? "substatus active" : "substatus"} onClick={() => { setOrderStatus(key); setPage(1); }}>
            {label}{count !== null && count > 0 && <span className="tab-count">{count.toLocaleString()}</span>}
          </button>;
        })}
      </div>}

      <div className="order-filters">
        <label>Store<select value={storeId} onChange={(event) => { setStoreId(event.target.value); setPage(1); }}>
          <option value="">All stores</option>
          {stores.map((store) => <option key={store.id} value={store.id}>{store.label}</option>)}
        </select></label>
        <label>Search<input type="search" maxLength={200} placeholder="Order, customer or tracking" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <label>Created from<input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} /></label>
        <label>Created to<input type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} /></label>
        <label>Sort by<select value={sort} onChange={(event) => { setSort(event.target.value); setPage(1); }}>
          <option value="updatedAt:desc">Recently updated</option>
          <option value="createdAt:desc">Newest orders</option>
          <option value="createdAt:asc">Oldest orders</option>
          <option value="amount:desc">Highest amount</option>
          <option value="customerName:asc">Customer A–Z</option>
        </select></label>
        <label>Rows<select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label>
      </div>

      {error && <p className="notice error">{error}</p>}
      {actionNotice && <p className="notice">{actionNotice}</p>}

      {selectedIds.size > 0 && <div className="bulk-bar">
        <span className="bulk-count">Selected {selectedIds.size} items</span>
        <button className="primary" disabled={bulkBusy} onClick={() => void bulkPackAndPrint()}>{bulkBusy ? "Working…" : "Pack & Print"}</button>
        <button className="secondary" onClick={() => void printOrders(selectedOrders, "picklist")}>Print PickList</button>
        <button className="secondary" onClick={() => void printOrders(selectedOrders, "invoice")}>Print Invoices</button>
        <button className="text-button" onClick={() => setSelectedIds(new Set())}>Clear</button>
      </div>}

      <div className="order-list-head">
        <label><input type="checkbox" checked={rows.length > 0 && selectedIds.size === rows.length} onChange={toggleAll} /> Select page</label>
        <span className="muted">{pageText}</span>
      </div>

      <div className="order-cards">
        {rows.map((order) => {
          const note = localStorage.getItem(`daraz-hub-note:${order.id}`) ?? "";
          const ageHours = Math.max(0, Math.round((Date.now() - new Date(order.orderCreatedAt).getTime()) / 3_600_000));
          return <article key={`${order.id}-${noteVersion}`} className={selectedIds.has(order.id) ? "order-card selected" : "order-card"}>
            <div className="order-card-head">
              <input type="checkbox" checked={selectedIds.has(order.id)} onChange={() => setSelectedIds((previous) => {
                const next = new Set(previous);
                if (next.has(order.id)) next.delete(order.id); else next.add(order.id);
                return next;
              })} aria-label={`Select order ${order.darazOrderId}`} />
              <div className="order-customer"><strong>{order.customerName ?? "—"}</strong><span>{order.itemCount ?? 0} item(s) · {order.store.label}</span></div>
              <div className="order-card-meta">
                <span>Order <b>{order.darazOrderId}</b> <button type="button" className="copy-icon" title="Copy order number" aria-label={`Copy order number ${order.darazOrderId}`} onClick={() => void copyOrderNumber(order)}>⧉</button></span>
                <span>{dateLabel(order.orderCreatedAt)}</span>
              </div>
            </div>
            <div className="order-card-body">
              <div><span>Amount</span><strong>{formatMoney(order.amount)}</strong></div>
              <div><span>Delivery</span><strong>{order.deliveryStatus ?? "—"}</strong></div>
              <div><span>Status</span><OrderStatusBadge order={order} /></div>
              <div><span>Age</span><strong>{ageHours} hrs</strong></div>
              <div><span>Tracking</span><strong>{order.trackingNumber ?? "—"}</strong></div>
            </div>
            {note && <p className="order-note">Note: {note}</p>}
            <div className="order-card-actions">
              <button className="primary" disabled={bulkBusy || !canFulfil(order)} onClick={() => void packAndPrint(order)}>Pack &amp; Print</button>
              <button className="secondary" onClick={() => setSelected(order)}>Details</button>
              <div className="more-wrap">
                <button className="secondary" onClick={() => setMoreMenu(moreMenu === order.id ? null : order.id)}>More Actions ▾</button>
                {moreMenu === order.id && <div className="more-menu">
                  <button disabled={!order.trackingNumber || bulkBusy} onClick={() => void generateInvoice(order)}>Generate &amp; Print Invoice</button>
                  <button onClick={() => { setMoreMenu(null); void printOrders([order], "picklist"); }}>Print PickList</button>
                  <button onClick={() => { setMoreMenu(null); void printOrders([order], "invoice"); }}>Print Invoice</button>
                  <button onClick={() => sellerNote(order)}>Seller Note</button>
                  <button disabled title="Daraz does not expose seller cancellation through the API">Cancel Order</button>
                  <button disabled title="Not available through the Daraz API">Request Extension</button>
                </div>}
              </div>
            </div>
          </article>;
        })}
        {!loading && rows.length === 0 && <div className="orders-empty">No orders in this lane yet. Check the store's sync settings, then run a sync.</div>}
        {loading && <div className="orders-empty">Loading orders…</div>}
      </div>
      <div className="pagination"><span>{pageText}</span><div><button className="secondary" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} of {Math.max(totalPages, 1)}</span><button className="secondary" disabled={page >= totalPages || loading} onClick={() => setPage(page + 1)}>Next</button></div></div>
    </section>
    {selected && <OrderDrawer token={token} order={selected} onClose={() => setSelected(null)} />}
  </>;
}

function OrderDrawer({ token, order, onClose }: { token: string; order: OrderRow; onClose: () => void }) {
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const [awbBusy, setAwbBusy] = useState(false);
  const [awbError, setAwbError] = useState("");
  const [actionBusy, setActionBusy] = useState<"" | "package" | "rts">("");
  const [actionNotice, setActionNotice] = useState("");
  const [actionError, setActionError] = useState("");

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError("");
    try {
      setDetail(await api(`/orders/${order.id}${refresh ? "?refresh=1" : ""}`, token));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load order details.");
    } finally {
      setLoading(false);
    }
  }, [order.id, token]);

  async function printAwb() {
    setAwbBusy(true);
    setAwbError("");
    try {
      const result = await api(`/orders/${order.id}/awb`, token);
      if (result.pdfUrl) window.open(result.pdfUrl, "_blank", "noopener,noreferrer");
      else setAwbError("Daraz did not return an AWB PDF yet. Try again in a moment.");
    } catch (e) {
      setAwbError(e instanceof Error ? e.message : "Unable to fetch the AWB PDF.");
    } finally {
      setAwbBusy(false);
    }
  }

  async function runAction(action: "package" | "rts") {
    const message = action === "package"
      ? `Create a Daraz package for order ${order.darazOrderId}? Daraz will assign the tracking number.`
      : `Mark order ${order.darazOrderId} ready to ship? Only do this once the package is packed and ready for pickup.`;
    if (!confirm(message)) return;
    setActionBusy(action);
    setActionNotice("");
    setActionError("");
    try {
      if (action === "package") {
        const result = await api(`/orders/${order.id}/package`, token, { method: "POST" });
        setActionNotice(result.created === false ? result.message ?? "Package already exists." : "Package created — Daraz assigned the tracking number.");
      } else {
        await api(`/orders/${order.id}/rts`, token, { method: "POST" });
        setActionNotice("Order marked ready to ship.");
      }
      await load(true);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Daraz rejected the request.");
    } finally {
      setActionBusy("");
    }
  }

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  const data = detail?.rawDetails?.data ?? {};
  const items: any[] = Array.isArray(data.order_items) ? data.order_items : [];
  const address = data.address_shipping ?? {};
  const isChoice = order.store.storeType === "choice";
  const hasPackage = items.some((item) => item.package_id);
  const currentGroup = detail?.statusGroup ?? order.statusGroup;
  const canCreatePackage = !isChoice && !hasPackage && !["canceled", "delivered", "returned", "failed_delivery"].includes(currentGroup ?? "");
  const canRts = !isChoice && hasPackage && currentGroup === "to_ship";
  const customerName = detail?.customerName
    || `${address.first_name ?? ""} ${address.last_name ?? ""}`.trim()
    || order.customerName
    || "—";

  return <div className="drawer-overlay" onClick={onClose}>
    <aside className="order-drawer" role="dialog" aria-modal="true" aria-label={`Order ${order.darazOrderId}`} onClick={(event) => event.stopPropagation()}>
      <header className="drawer-head">
        <div><p className="eyebrow">ORDER DETAIL</p><h2>{order.darazOrderId}</h2><div className="drawer-badges"><StatusBadge group={detail?.statusGroup ?? order.statusGroup} /><span className="muted">{detail?.store?.label ?? order.store.label} · {order.store.country}</span></div></div>
        <button className="icon-button drawer-close" aria-label="Close order details" onClick={onClose}>×</button>
      </header>

      <div className="drawer-body">
        {error && <p className="notice error">{error}</p>}
        {loading ? <p className="muted">Loading the latest details from Daraz…</p> : <>
          <div className="drawer-grid">
            <div><span>Customer</span><strong>{customerName}</strong></div>
            <div><span>Amount</span><strong>{formatMoney(detail?.amount ?? order.amount)}</strong></div>
            <div><span>Items</span><strong>{detail?.itemCount ?? order.itemCount ?? items.length}</strong></div>
            <div><span>Payment</span><strong>{data.payment_method || "—"}</strong></div>
            <div><span>Created</span><strong>{dateLabel(detail?.orderCreatedAt ?? order.orderCreatedAt)}</strong></div>
            <div><span>Updated</span><strong>{dateLabel(detail?.orderUpdatedAt ?? order.orderUpdatedAt)}</strong></div>
            <div><span>Tracking</span><strong>{detail?.trackingNumber ?? order.trackingNumber ?? "—"}</strong></div>
            <div><span>Shipping fee</span><strong>{formatMoney(data.shipping_fee)}</strong></div>
          </div>

          <h3>Items ({items.length})</h3>
          {items.length === 0 ? <p className="muted">No line items returned by Daraz.</p> : <div className="drawer-items">
            {items.map((item: any) => <article key={item.order_item_id ?? item.sku} className="drawer-item">
              <div className="drawer-item-name">{item.name ?? "Unnamed item"}</div>
              <div className="drawer-item-meta">
                <span>SKU {item.shop_sku ?? item.sku ?? "—"}</span>
                <span>Qty {item.quantity ?? 1}</span>
                <span>{formatMoney(item.paid_price)}</span>
                <StatusBadge group={item.status} />
                {item.tracking_code ? <span>Tracking {item.tracking_code}</span> : null}
              </div>
            </article>)}
          </div>}

          <h3>Shipping address</h3>
          <address className="drawer-address">
            <strong>{customerName}</strong>
            <span>{address.phone || "—"}</span>
            <span>{[address.address1, address.address2, address.address3].filter(Boolean).join(", ") || "—"}</span>
            <span>{[address.city, address.post_code, address.country].filter(Boolean).join(", ")}</span>
          </address>

          <div className="drawer-actions">
            {!isChoice && <>
              <button className="secondary" disabled={awbBusy} onClick={() => void printAwb()}>{awbBusy ? "Opening AWB…" : "Print AWB"}</button>
              {canCreatePackage && <button className="secondary" disabled={actionBusy !== ""} onClick={() => void runAction("package")}>{actionBusy === "package" ? "Creating package…" : "Create package"}</button>}
              {canRts && <button className="secondary" disabled={actionBusy !== ""} onClick={() => void runAction("rts")}>{actionBusy === "rts" ? "Marking RTS…" : "Mark RTS"}</button>}
            </>}
            <button className="secondary" disabled={loading} onClick={() => void load(true)}>Refresh from Daraz</button>
            <button className="text-button" onClick={() => setShowRaw((value) => !value)}>{showRaw ? "Hide raw payload" : "Show raw payload"}</button>
          </div>
          {isChoice && <p className="muted">Choice seller — orders are synced for billing only. Daraz handles packing, RTS and AWB printing.</p>}
          {awbError && <p className="notice error">{awbError}</p>}
          {actionNotice && <p className="notice">{actionNotice}</p>}
          {actionError && <p className="notice error">{actionError}</p>}
          {!isChoice && <OrderInvoice token={token} order={order} />}
          {showRaw && <pre className="drawer-raw">{JSON.stringify(detail?.rawDetails ?? {}, null, 2)}</pre>}
        </>}
      </div>
    </aside>
  </div>;
}

type ProductRow = {
  id: string; storeId: string; darazItemId: string; sellerSku: string | null; name: string | null;
  brand: string | null; status: string | null; imageUrl: string | null;
  price: string | null; specialPrice: string | null; quantity: number | null;
  syncedFrom: string | null; fetchedAt: string;
  _count?: { variants: number };
  store: { label: string; country: string; storeType?: string };
};

function ProductThumb({ src, alt }: { src?: string | null; alt: string }) {
  return src
    ? <img className="product-thumb" src={src} alt={alt} loading="lazy" />
    : <span className="product-thumb placeholder" aria-hidden="true">▦</span>;
}

function Products({ token, stores }: { token: string; stores: Store[] }) {
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [storeId, setStoreId] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<ProductRow | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncNotice, setSyncNotice] = useState("");

  const selectedStore = stores.find((store) => store.id === storeId);

  async function syncProducts() {
    if (!storeId) return;
    setSyncBusy(true);
    setSyncNotice("");
    try {
      const result = await api(`/stores/${storeId}/products/sync`, token, { method: "POST" });
      setSyncNotice(result.message ?? "Product sync queued.");
    } catch (e) {
      setSyncNotice(e instanceof Error ? e.message : "Unable to queue a product sync.");
    } finally {
      setSyncBusy(false);
    }
  }

  async function fullResyncProducts() {
    if (!storeId) return;
    const label = selectedStore?.label ?? "this store";
    if (!confirm(`Re-fetch the entire catalog for ${label}? This clears the saved sync cursor and restarts from the beginning.`)) return;
    setSyncBusy(true);
    setSyncNotice("");
    try {
      const result = await api(`/stores/${storeId}/products/resync`, token, { method: "POST" });
      setSyncNotice(result.message ?? "Full product resync queued.");
    } catch (e) {
      setSyncNotice(e instanceof Error ? e.message : "Unable to queue a full product resync.");
    } finally {
      setSyncBusy(false);
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 350);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!token) return;
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (storeId) params.set("storeId", storeId);
    if (debouncedSearch) params.set("search", debouncedSearch);
    let current = true;
    setLoading(true);
    api(`/products?${params}`, token).then((data) => {
      if (!current) return;
      setRows(data.products);
      setTotal(data.total);
      setTotalPages(data.totalPages);
      setError("");
    }).catch((e) => { if (current) setError(e instanceof Error ? e.message : "Unable to load products."); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [token, page, pageSize, storeId, debouncedSearch]);

  const pageText = total === 0 ? "0 products" : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total.toLocaleString()}`;

  return <>
    <section className="panel">
      <div className="section-head">
        <div><h2>Products <span className="count">{total.toLocaleString()}</span></h2><p className="muted">Store-wise catalog with variants, images, price and stock. New-order SKUs are added automatically.</p></div>
        <div className="head-actions">
          <button className="secondary" disabled={!storeId || syncBusy || selectedStore?.storeType === "choice"} title={!storeId ? "Select a store first" : selectedStore?.storeType === "choice" ? "Choice sellers cannot use the Daraz products API" : "Queue a catalog sync for the selected store"} onClick={() => void syncProducts()}>{syncBusy ? "Queuing…" : "Sync products"}</button>
          <button className="secondary" disabled={!storeId || syncBusy || selectedStore?.storeType === "choice"} title={selectedStore?.storeType === "choice" ? "Choice sellers cannot use the Daraz products API" : "Clear the catalog cursor and re-fetch every product"} onClick={() => void fullResyncProducts()}>Full resync</button>
        </div>
      </div>
      <div className="order-filters">
        <label>Store<select value={storeId} onChange={(event) => { setStoreId(event.target.value); setPage(1); }}>
          <option value="">All stores</option>
          {stores.map((store) => <option key={store.id} value={store.id}>{store.label}</option>)}
        </select></label>
        <label>Search<input type="search" maxLength={200} placeholder="Product, item ID or SKU" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <label>Rows<select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label>
      </div>
      {syncNotice && <p className="notice">{syncNotice}</p>}
      {selectedStore?.storeType === "choice" && <p className="muted">Choice seller — products are created from order items only; the Daraz products API is disabled for this store.</p>}
      {selectedStore && selectedStore.storeType !== "choice" && <p className="muted">
        {selectedStore.productSyncRunning
          ? "Product sync running now…"
          : (selectedStore.productSyncOffset ?? 0) > 0
            ? `Initial product sync in progress (${selectedStore.productSyncOffset?.toLocaleString()} products processed).`
            : selectedStore.productSyncLastAt
              ? `Last product sync: ${dateLabel(selectedStore.productSyncLastAt)}.`
              : "No product sync has run for this store yet."}
        {selectedStore.productSyncError ? ` Last error: ${selectedStore.productSyncError}` : ""}
      </p>}
      {error && <p className="notice error">{error}</p>}
      <div className="table-wrap"><table>
        <thead><tr><th></th><th>Product</th><th>Store</th><th>SKUs</th><th>Price</th><th>Offer</th><th>Stock</th><th>Status</th></tr></thead>
        <tbody>{rows.map((product) => <tr key={product.id} className="order-row" onClick={() => setSelected(product)}>
          <td><ProductThumb src={product.imageUrl} alt={product.name ?? "Product"} /></td>
          <td><button className="link-button order-id" onClick={(event) => { event.stopPropagation(); setSelected(product); }}>{product.name ?? `Item ${product.darazItemId}`}</button><small>{product.darazItemId}{product.brand ? ` · ${product.brand}` : ""}{product.syncedFrom === "order" ? " · from order" : ""}</small></td>
          <td>{product.store.label}</td>
          <td>{product._count?.variants ?? 0}</td>
          <td className="money">{formatMoney(product.price)}</td>
          <td>{product.specialPrice ? formatMoney(product.specialPrice) : "—"}</td>
          <td>{product.quantity ?? "—"}</td>
          <td>{product.status ?? "—"}</td>
        </tr>)}
        {!loading && rows.length === 0 && <tr><td colSpan={8} className="orders-empty">No products yet. Run a store sync, or new orders will add their SKUs automatically.</td></tr>}
        {loading && <tr><td colSpan={8} className="orders-empty">Loading products…</td></tr>}
        </tbody></table></div>
      <div className="pagination"><span>{pageText}</span><div><button className="secondary" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} of {Math.max(totalPages, 1)}</span><button className="secondary" disabled={page >= totalPages || loading} onClick={() => setPage(page + 1)}>Next</button></div></div>
    </section>
    {selected && <ProductDrawer token={token} product={selected} onClose={() => setSelected(null)} />}
  </>;
}

function ProductDrawer({ token, product, onClose }: { token: string; product: ProductRow; onClose: () => void }) {
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    api(`/products/${product.id}`, token)
      .then((data) => { if (active) setDetail(data); })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : "Unable to load product."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [product.id, token]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  const variants: any[] = detail?.variants ?? [];

  return <div className="drawer-overlay" onClick={onClose}>
    <aside className="order-drawer" role="dialog" aria-modal="true" aria-label={`Product ${product.name ?? product.darazItemId}`} onClick={(event) => event.stopPropagation()}>
      <header className="drawer-head">
        <div className="product-head">
          <ProductThumb src={detail?.imageUrl ?? product.imageUrl} alt={product.name ?? "Product"} />
          <div><p className="eyebrow">PRODUCT</p><h2>{detail?.name ?? product.name ?? `Item ${product.darazItemId}`}</h2><span className="muted">{product.store.label} · Item {product.darazItemId}{detail?.brand ? ` · ${detail.brand}` : ""}</span></div>
        </div>
        <button className="icon-button drawer-close" aria-label="Close product" onClick={onClose}>×</button>
      </header>
      <div className="drawer-body">
        {error && <p className="notice error">{error}</p>}
        {loading ? <p className="muted">Loading product…</p> : <>
          <div className="drawer-grid">
            <div><span>Price</span><strong>{formatMoney(detail?.price)}</strong></div>
            <div><span>Offer price</span><strong>{detail?.specialPrice ? formatMoney(detail.specialPrice) : "—"}</strong></div>
            <div><span>Stock</span><strong>{detail?.quantity ?? "—"}</strong></div>
            <div><span>Status</span><strong>{detail?.status ?? "—"}</strong></div>
            <div><span>Variants</span><strong>{variants.length}</strong></div>
            <div><span>Source</span><strong>{detail?.syncedFrom === "order" ? "Order item" : "Catalog"}</strong></div>
          </div>
          <h3>Variants ({variants.length})</h3>
          {variants.length === 0 ? <p className="muted">No variant records.</p> : <div className="table-wrap"><table>
            <thead><tr><th></th><th>SKU</th><th>Colour / size</th><th>Price</th><th>Offer</th><th>Stock</th><th>Status</th></tr></thead>
            <tbody>{variants.map((variant: any) => <tr key={variant.id}>
              <td><ProductThumb src={variant.imageUrl ?? detail?.imageUrl} alt={variant.sku} /></td>
              <td>{variant.sku}</td>
              <td>{[variant.color, variant.size].filter(Boolean).join(" / ") || "—"}</td>
              <td>{formatMoney(variant.price)}</td>
              <td>{variant.specialPrice ? formatMoney(variant.specialPrice) : "—"}</td>
              <td>{variant.quantity ?? "—"}</td>
              <td>{variant.status ?? "—"}</td>
            </tr>)}</tbody></table></div>}
        </>}
      </div>
    </aside>
  </div>;
}

type AdminLogJob = {
  id: string; storeId: string; storeLabel: string; kind: "orders" | "products";
  state: "running" | "queued" | "scheduled" | "failed" | "idle";
  lastAt: string | null; nextAt: string | null; lockUntil: string | null; error: string | null; progress: string;
};
type AdminLogsData = {
  generatedAt: string;
  storeOptions: Array<{ id: string; label: string; isActive: boolean }>;
  stores: Array<{
    id: string; label: string; country: string; storeType: string; isActive: boolean;
    owner: { name: string; email: string } | null; status: string; orders: number | null; products: number;
    orderSync: { lastAt: string | null; nextAt: string | null; lockUntil: string | null; running: boolean; backfillDone: boolean; backfillCursor: string | null; frequency: string; error: string | null };
    productSync: { lastAt: string | null; nextAt: string | null; lockUntil: string | null; running: boolean; offset: number; error: string | null };
  }>;
  jobs: AdminLogJob[];
  logs: Array<{ id: string; action: string; createdAt: string; userEmail: string | null; storeLabel: string | null; meta: any }>;
};

async function imsPdf(token: string, invoiceId: string, download: boolean) {
  const response = await fetch(`/api/ims/invoices/${invoiceId}/pdf?download=${download ? "1" : "0"}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Unable to open invoice PDF.");
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  if (download) {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "ims-tax-invoice.pdf";
    anchor.click();
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function OrderInvoice({ token, order }: { token: string; order: OrderRow }) {
  const [invoice, setInvoice] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const data = await api(`/ims/invoices/order/${order.id}`, token);
      setInvoice(data.invoice);
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to load invoice."); }
    finally { setLoading(false); }
  }, [order.id, token]);
  useEffect(() => { void load(); }, [load]);
  async function generate() {
    if (!confirm(`Generate an IMS tax invoice?\n\nOrder: ${order.darazOrderId}\nTracking: ${order.trackingNumber ?? "—"}\nCustomer: ${order.customerName ?? "—"}\nAmount: ${formatMoney(order.amount)}\n\nThis creates the official IMS invoice and cannot be undone.`)) return;
    setBusy(true); setError("");
    try {
      const result = await api("/ims/invoices/generate", token, { method: "POST", body: JSON.stringify({ orderId: order.id, confirm: true }) });
      setInvoice(result.invoice);
      if (result.invoice?.pdfPath) await imsPdf(token, result.invoice.id, false).catch(() => {});
    } catch (e) { setError(e instanceof Error ? e.message : "Invoice generation failed."); await load(); }
    finally { setBusy(false); }
  }
  async function recover() {
    if (!invoice) return;
    setBusy(true);
    try {
      const result = await api(`/ims/invoices/${invoice.id}/recover-pdf`, token, { method: "POST" });
      setInvoice(result.invoice);
    } catch (e) { setError(e instanceof Error ? e.message : "PDF recovery failed."); }
    finally { setBusy(false); }
  }
  if (loading) return <p className="muted">Loading tax invoice…</p>;
  return <section className="order-invoice">
    <h3>Tax Invoice</h3>
    {error && <p className="notice error">{error}</p>}
    {invoice ? <>
      <div className="drawer-grid">
        <div><span>IMS Invoice No.</span><strong>{invoice.imsInvoiceNumber ?? "Pending verification"}</strong></div>
        <div><span>Invoice date</span><strong>{invoice.invoiceDate ? dateLabel(invoice.invoiceDate) : "—"}</strong></div>
        <div><span>Generated</span><strong>{invoice.generatedAt ? dateLabel(invoice.generatedAt) : "—"}</strong></div>
        <div><span>Generated by</span><strong>{invoice.generatedByName ?? "—"}</strong></div>
        <div><span>Tracking</span><strong>{invoice.trackingNumber}</strong></div>
        <div><span>Status</span><strong>{String(invoice.status).replaceAll("_", " ")}</strong></div>
      </div>
      {invoice.error && <p className="muted">{invoice.error}</p>}
      <div className="drawer-actions">
        {invoice.pdfPath && <>
          <button className="secondary" onClick={() => void imsPdf(token, invoice.id, false)}>View Invoice</button>
          <button className="secondary" onClick={() => void imsPdf(token, invoice.id, true)}>Download PDF</button>
          <button className="secondary" onClick={() => void imsPdf(token, invoice.id, false)}>Print Tax Invoice</button>
        </>}
        {invoice.status === "pdf_recovery_required" && <button className="secondary" disabled={busy} onClick={() => void recover()}>{busy ? "Recovering…" : "Recover PDF"}</button>}
      </div>
    </> : <div className="drawer-actions">
      <button className="primary" disabled={busy || !order.trackingNumber} onClick={() => void generate()}>{busy ? "Generating…" : "Generate & Print Tax Invoice"}</button>
      {!order.trackingNumber && <span className="muted">Tracking number required.</span>}
    </div>}
  </section>;
}

function ImsInvoices({ token, history = false }: { token: string; history?: boolean }) {
  const [data, setData] = useState<any>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setData(await api(`/ims/invoices?${new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}) })}`, token)); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to load invoices."); }
  }, [token, q, status]);
  useEffect(() => { const timer = setTimeout(() => { void load(); }, 250); return () => clearTimeout(timer); }, [load]);
  return <>
    <div className="stat-grid">
      <article className="stat-card"><div className="stat-head"><span>Total invoices</span><span className="stat-icon icon-0">▤</span></div><strong>{data?.summary?.total ?? "—"}</strong><small>all invoice records</small></article>
      <article className="stat-card"><div className="stat-head"><span>Generated today</span><span className="stat-icon icon-1">✓</span></div><strong>{data?.summary?.today ?? "—"}</strong><small>Asia/Kathmandu</small></article>
      <article className="stat-card"><div className="stat-head"><span>Pending verification</span><span className="stat-icon icon-2">◷</span></div><strong>{data?.summary?.pending ?? "—"}</strong><small>verify in IMS before retrying</small></article>
      <article className="stat-card"><div className="stat-head"><span>Failed</span><span className="stat-icon icon-3">!</span></div><strong>{data?.summary?.failed ?? "—"}</strong><small>invoice requests</small></article>
    </div>
    <section className="panel">
      <div className="section-head"><div><h2>{history ? "Invoice History" : "Invoice Management"}</h2><p className="muted">IMS-generated tax invoices; PDFs are private and authenticated.</p></div></div>
      <div className="order-filters">
        <label>Search<input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Tracking, IMS invoice or Daraz order" /></label>
        <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All</option><option value="generated">Generated</option><option value="pending_verification">Pending verification</option><option value="pdf_recovery_required">PDF recovery required</option><option value="failed">Failed</option></select></label>
      </div>
      {error && <p className="notice error">{error}</p>}
      <div className="table-wrap"><table>
        <thead><tr><th>IMS Invoice</th><th>Tracking</th><th>Daraz orders</th><th>Invoice date</th><th>Generated</th><th>By</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>{(data?.invoices ?? []).map((invoice: any) => <tr key={invoice.id}>
          <td>{invoice.imsInvoiceNumber ?? "—"}</td>
          <td>{invoice.trackingNumber}</td>
          <td>{invoice.orders.map((link: any) => link.order.darazOrderId).join(", ")}</td>
          <td>{invoice.invoiceDate ? dateLabel(invoice.invoiceDate) : "—"}</td>
          <td>{invoice.generatedAt ? dateLabel(invoice.generatedAt) : "—"}</td>
          <td>{invoice.generatedByName ?? "—"}</td>
          <td><span className={`badge ${invoice.status === "generated" ? "connected" : invoice.status === "failed" ? "error" : "to_ship"}`}>{String(invoice.status).replaceAll("_", " ")}</span></td>
          <td><div className="head-actions">
            {invoice.pdfPath && <>
              <button className="text-button" onClick={() => void imsPdf(token, invoice.id, false)}>View</button>
              <button className="text-button" onClick={() => void imsPdf(token, invoice.id, true)}>Download</button>
              <button className="text-button" onClick={() => void imsPdf(token, invoice.id, false)}>Print</button>
            </>}
          </div></td>
        </tr>)}
        {data && data.invoices.length === 0 && <tr><td colSpan={8} className="orders-empty">No invoices found.</td></tr>}</tbody>
      </table></div>
    </section>
  </>;
}

function ImsSettings({ token }: { token: string }) {
  const [form, setForm] = useState<any>({ baseUrl: "https://ecomapi.imssoftware.com.np", companyId: "", branchCode: "", imsUser: "", warehouse: "Main Warehouse", paymentMode: "cash", voucherType: "TI", apiKey: "" });
  const [saved, setSaved] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    api("/admin/ims/settings", token).then((data) => {
      setSaved(data);
      if (data.configured) setForm((previous: any) => ({ ...previous, ...data, apiKey: "" }));
    }).catch((e) => setError(e instanceof Error ? e.message : "Unable to load IMS settings."));
  }, [token]);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const payload: any = { baseUrl: form.baseUrl, companyId: form.companyId, branchCode: form.branchCode, imsUser: form.imsUser, warehouse: form.warehouse, paymentMode: form.paymentMode, voucherType: form.voucherType };
      if (form.apiKey) payload.apiKey = form.apiKey;
      const result = await api("/admin/ims/settings", token, { method: "PUT", body: JSON.stringify(payload) });
      setSaved(result); setNotice("IMS settings saved."); setForm((previous: any) => ({ ...previous, apiKey: "" }));
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save IMS settings."); }
    finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setError(""); setNotice("");
    try { const result = await api("/admin/ims/test", token, { method: "POST" }); setNotice(`IMS connection OK · ${dateLabel(result.testedAt)}`); }
    catch (e) { setError(e instanceof Error ? e.message : "IMS connection failed."); }
    finally { setBusy(false); }
  }
  return <section className="panel narrow">
    <div className="section-head"><div><h2>IMS Settings</h2><p className="muted">Credentials are encrypted at rest and never returned to the browser.</p></div></div>
    {error && <p className="notice error">{error}</p>}
    {notice && <p className="notice">{notice}</p>}
    <form className="form-stack" onSubmit={save}>
      <label>API Base URL<input required value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder="https://ecomapi.imssoftware.com.np" /></label>
      <label>Company ID<input required value={form.companyId} onChange={(event) => setForm({ ...form, companyId: event.target.value })} /></label>
      <label>Branch code<input required value={form.branchCode} onChange={(event) => setForm({ ...form, branchCode: event.target.value })} placeholder="MMX" /></label>
      <label>IMS user<input required value={form.imsUser} onChange={(event) => setForm({ ...form, imsUser: event.target.value })} /></label>
      <label>Warehouse<input required value={form.warehouse} onChange={(event) => setForm({ ...form, warehouse: event.target.value })} /></label>
      <label>Payment mode<select value={form.paymentMode} onChange={(event) => setForm({ ...form, paymentMode: event.target.value })}><option value="cash">cash</option><option value="credit">credit</option><option value="creditcard">creditcard</option><option value="fonepay">fonepay</option></select></label>
      <label>Voucher type<select value={form.voucherType} onChange={(event) => setForm({ ...form, voucherType: event.target.value })}><option value="TI">Tax Invoice (TI)</option><option value="SI">Abbreviated Tax Invoice (SI)</option></select></label>
      <label>API key<input type="password" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} placeholder={saved?.hasApiKey ? "Saved — leave blank to keep" : "Required"} /></label>
      <div className="head-actions"><button disabled={busy}>Save settings</button><button type="button" className="secondary" disabled={busy} onClick={() => void test()}>Test API connection</button></div>
    </form>
    <p className="muted">Last successful connection: {saved?.lastSuccessAt ? dateLabel(saved.lastSuccessAt) : "never"}{saved?.lastError ? ` · Last error: ${saved.lastError}` : ""}</p>
  </section>;
}

function AdminLogs({ token }: { token: string }) {
  const [data, setData] = useState<AdminLogsData | null>(null);
  const [storeId, setStoreId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await api(`/admin/logs${storeId ? `?storeId=${storeId}` : ""}`, token);
      setData(result);
      setUpdatedAt(new Date().toLocaleTimeString());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load store logs.");
    } finally {
      setLoading(false);
    }
  }, [token, storeId]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  useEffect(() => {
    const timer = setInterval(() => { void load(); }, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  if (error) return <section className="panel"><p className="notice error">{error}</p><button className="secondary" onClick={() => void load()}>Retry</button></section>;
  if (!data) return <section className="panel"><p className="muted">{loading ? "Loading store logs…" : "No store logs."}</p></section>;

  const order = { running: 0, queued: 0, scheduled: 0, failed: 0, idle: 0 };
  for (const job of data.jobs) order[job.state] += 1;
  const rank = { running: 0, queued: 1, failed: 2, scheduled: 3, idle: 4 } as const;
  const jobs = [...data.jobs].sort((first, second) => rank[first.state] - rank[second.state] || first.storeLabel.localeCompare(second.storeLabel));

  return <>
    <div className="dash-toolbar">
      <div className="head-actions">
        <select value={storeId} onChange={(event) => setStoreId(event.target.value)} aria-label="Filter by store">
          <option value="">All stores</option>
          {data.storeOptions.map((store) => <option key={store.id} value={store.id}>{store.label}{store.isActive ? "" : " (inactive)"}</option>)}
        </select>
        <button className="secondary" onClick={() => void load()}>Refresh</button>
      </div>
      <span className="dash-updated">Queue refreshes every 10s · updated {updatedAt}</span>
    </div>

    <div className="stat-grid">
      <article className="stat-card"><div className="stat-head"><span>Running jobs</span><span className="stat-icon icon-0">▶</span></div><strong>{order.running}</strong><small>order + product sync leases held</small></article>
      <article className="stat-card"><div className="stat-head"><span>Queued</span><span className="stat-icon icon-1">◷</span></div><strong>{order.queued}</strong><small>due now, waiting for a worker</small></article>
      <article className="stat-card"><div className="stat-head"><span>Scheduled</span><span className="stat-icon icon-2">⌁</span></div><strong>{order.scheduled}</strong><small>next run in the future</small></article>
      <article className="stat-card"><div className="stat-head"><span>Errors</span><span className="stat-icon icon-3">!</span></div><strong>{order.failed}</strong><small>stores with a sync error</small></article>
    </div>

    <section className="panel">
      <div className="section-head"><div><h2>Sync queue</h2><p className="muted">Running leases, queued jobs and scheduled passes for every store.</p></div></div>
      <div className="table-wrap"><table>
        <thead><tr><th>Store</th><th>Job</th><th>State</th><th>Progress</th><th>Last run</th><th>Next / lease</th><th>Error</th></tr></thead>
        <tbody>{jobs.map((job) => <tr key={job.id}>
          <td><strong>{job.storeLabel}</strong></td>
          <td>{job.kind === "orders" ? "Order sync" : "Product sync"}</td>
          <td><span className={`job-state ${job.state}`}>{job.state}</span></td>
          <td className="muted">{job.progress}</td>
          <td>{job.lastAt ? dateLabel(job.lastAt) : "Never"}</td>
          <td>{job.state === "running" && job.lockUntil ? `Lease until ${dateLabel(job.lockUntil)}` : job.nextAt ? dateLabel(job.nextAt) : "Manual / idle"}</td>
          <td>{job.error ? <span className="warning" title={job.error}>{job.error.slice(0, 70)}</span> : <span className="ok">OK</span>}</td>
        </tr>)}</tbody></table></div>
    </section>

    <section className="panel">
      <div className="section-head"><div><h2>Store sync status</h2><p className="muted">Counts, backfill state and last successful pass.</p></div></div>
      <div className="table-wrap"><table>
        <thead><tr><th>Store</th><th>Owner</th><th>Status</th><th>Products</th><th>Order sync</th><th>Product sync</th><th>Frequency</th></tr></thead>
        <tbody>{data.stores.map((store) => <tr key={store.id}>
          <td><strong>{store.label}</strong><small>{store.country}{store.storeType === "choice" ? " · Choice" : ""}{store.isActive ? "" : " · inactive"}</small></td>
          <td>{store.owner?.email ?? "—"}</td>
          <td><span className={`badge ${store.status}`}>{store.status.replace("_", " ")}</span></td>
          <td>{store.products.toLocaleString()}</td>
          <td>{store.orderSync.backfillDone ? "Backfill complete" : store.orderSync.backfillCursor ? `From ${store.orderSync.backfillCursor.slice(0, 10)}` : "Waiting"}<small>{store.orderSync.lastAt ? dateLabel(store.orderSync.lastAt) : "Never"}</small></td>
          <td>{store.productSync.offset > 0 ? `${store.productSync.offset} processed` : "Idle"}<small>{store.productSync.lastAt ? dateLabel(store.productSync.lastAt) : "Never"}</small></td>
          <td>{store.orderSync.frequency.replaceAll("_", " ")}</td>
        </tr>)}</tbody></table></div>
    </section>

    <section className="panel">
      <div className="section-head"><div><h2>Store activity logs</h2><p className="muted">Latest {data.logs.length} audit events{storeId ? " for the selected store" : ""}.</p></div></div>
      {data.logs.length === 0
        ? <p className="muted">No activity recorded yet.</p>
        : <div className="table-wrap"><table>
          <thead><tr><th>Time</th><th>Store</th><th>Action</th><th>User</th><th>Details</th></tr></thead>
          <tbody>{data.logs.map((entry) => <tr key={entry.id}>
            <td>{dateLabel(entry.createdAt)}</td>
            <td>{entry.storeLabel ?? "—"}</td>
            <td>{entry.action.replaceAll("_", " ")}</td>
            <td>{entry.userEmail ?? "System"}</td>
            <td className="muted">{entry.meta?.reason ?? entry.meta?.phase ?? (entry.meta ? JSON.stringify(entry.meta).slice(0, 100) : "—")}</td>
          </tr>)}</tbody></table></div>}
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
