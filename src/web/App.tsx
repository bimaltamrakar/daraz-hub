import { FormEvent, useCallback, useEffect, useState } from "react";

type User = { id: string; name: string; email: string; role: "admin" | "user"; mustChangePassword: boolean };
type Store = { id: string; label: string; country: string; status: string; sellerId: string | null; accessExpiresAt: string | null; refreshExpiresAt: string | null; lastError: string | null };
type Summary = { total: number; connected: number; expiringSoon: number; expired: number };
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

export default function App() {
  const [token, setToken] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [page, setPage] = useState(location.pathname === "/admin" ? "admin" : "dashboard");
  const [stores, setStores] = useState<Store[]>([]);
  const [summary, setSummary] = useState<Summary>({ total: 0, connected: 0, expiringSoon: 0, expired: 0 });
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

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
    if (params.get("error") === "daraz_connection_failed") setNotice("Daraz authorization completed, but token exchange failed. Check the server logs and Daraz app configuration.");
    else if (params.has("error")) setNotice("Daraz authorization was not completed.");
    else if (params.has("connected")) setNotice("Store connected.");
  }, []);
  useEffect(() => {
    if (user) load();
  }, [user?.id]);

  async function submitAuth(event: FormEvent<HTMLFormElement>, mode: "login" | "signup") {
    event.preventDefault(); setBusy(true); setNotice("");
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const result = await api(`/auth/${mode}`, undefined, { method: "POST", body: JSON.stringify(data) });
      setToken(result.accessToken); setUser(result.user); setPage("dashboard");
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
    if (!confirm(`Remove ${store.label} and its saved tokens?`)) return;
    try { await api(`/stores/${store.id}`, token, { method: "DELETE" }); await load(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Unable to remove store."); }
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

  return <div className="app-shell">
    <aside className="sidebar"><a className="logo" href="/" onClick={(e) => { e.preventDefault(); setPage("dashboard"); }}><span className="brand-mark small">D</span><span>Daraz<span className="muted"> Hub</span></span></a>
      <div className="nav-caption">WORKSPACE</div>
      <button className={page === "dashboard" ? "nav active" : "nav"} onClick={() => setPage("dashboard")}>◫ &nbsp;Overview</button>
      <button className={page === "stores" ? "nav active" : "nav"} onClick={() => setPage("stores")}>▤ &nbsp;My stores</button>
      {user.role === "admin" && <><div className="nav-caption">ADMINISTRATION</div><button className={page === "admin" ? "nav active" : "nav"} onClick={() => setPage("admin")}>♙ &nbsp;Users & stores</button><button className={page === "audit" ? "nav active" : "nav"} onClick={() => setPage("audit")}>◷ &nbsp;Audit log</button></>}
      <div className="profile"><span className="avatar">{user.name[0]?.toUpperCase()}</span><div className="profile-text"><strong>{user.name}</strong><small>{user.email}</small></div><button className="icon-button" aria-label="Sign out" onClick={logout}>↗</button></div>
    </aside>
    <main className="main">
      <header className="topbar"><div><p className="eyebrow">YOUR WORKSPACE</p><h1>{page === "dashboard" ? "Overview" : page === "stores" ? "My stores" : page === "audit" ? "Audit log" : "Administration"}</h1></div><span className="secure"><span className="dot" /> Secure workspace</span></header>
      {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice("")}>×</button></div>}
      {user.mustChangePassword ? <section className="panel narrow"><h2>Set a new password</h2><p className="muted">The seeded administrator password must be changed before using this account.</p><form className="form-stack" onSubmit={changePassword}><label>Current password<input required name="currentPassword" type="password" /></label><label>New password<input required name="newPassword" type="password" minLength={12} /></label><button>Update password</button></form></section> :
      page === "dashboard" ? <>
        <div className="stat-grid">{[["Total stores", summary.total, "stores connected or pending"], ["Connected", summary.connected, "ready to use"], ["Expiring soon", summary.expiringSoon, "refresh token expires in 7 days"], ["Expired", summary.expired, "reconnect required"]].map(([title, value, sub], i) => <article className="stat-card" key={title}><div className="stat-head"><span>{title}</span><span className={`stat-icon icon-${i}`}>{["▤", "✓", "◷", "!"][i]}</span></div><strong>{value}</strong><small>{sub}</small></article>)}</div>
        <section className="panel"><div className="section-head"><div><h2>Store connections</h2><p className="muted">A quick look at your Daraz seller accounts.</p></div><button className="secondary" onClick={() => setPage("stores")}>Manage stores <span>→</span></button></div>
          {stores.length ? <StoreList stores={stores.slice(0, 3)} onConnect={connect} onRefresh={refresh} onRemove={remove} /> : <EmptyStores onClick={() => setPage("stores")} />}
        </section>
      </> : page === "stores" ? <>
        <section className="panel add-panel"><div><h2>Add a store</h2><p className="muted">Start with a label and your Daraz marketplace region.</p></div><form className="add-form" onSubmit={addStore}><label>Store label<input required name="label" placeholder="e.g. Kathmandu Outlet" maxLength={100} /></label><label>Country / region<select required name="country" defaultValue=""><option value="" disabled>Select region</option><option value="NP">Nepal (NP)</option><option value="PK">Pakistan (PK)</option><option value="BD">Bangladesh (BD)</option><option value="LK">Sri Lanka (LK)</option><option value="MM">Myanmar (MM)</option></select></label><button disabled={busy}>Add store</button></form></section>
        <section className="panel"><div className="section-head"><div><h2>Your stores <span className="count">{stores.length}</span></h2><p className="muted">Connect and keep each seller token up to date.</p></div></div>{stores.length ? <StoreList stores={stores} onConnect={connect} onRefresh={refresh} onRemove={remove} /> : <EmptyStores onClick={() => document.querySelector<HTMLInputElement>('input[name="label"]')?.focus()} />}</section>
      </> : page === "admin" ? <Admin token={token} /> : <Audit token={token} />}
      <footer>Daraz Store Hub <span>Tokens are encrypted at rest and never shown in the browser.</span></footer>
    </main>
  </div>;
}

function EmptyStores({ onClick }: { onClick: () => void }) { return <div className="empty"><span>▤</span><strong>No stores yet</strong><p>Add a Daraz seller store to see its connection and token health here.</p><button className="secondary" onClick={onClick}>Add your first store</button></div>; }
function StoreList({ stores, onConnect, onRefresh, onRemove }: { stores: Store[]; onConnect: (store: Store) => void; onRefresh: (store: Store) => void; onRemove: (store: Store) => void }) {
  return <div className="store-list">{stores.map((store) => {
    const refreshDays = daysUntil(store.refreshExpiresAt);
    return <article className="store-row" key={store.id}><div className="store-avatar">▤</div><div className="store-info"><div className="store-title"><strong>{store.label}</strong><span className={`badge ${store.status}`}>{store.status.replace("_", " ")}</span></div><span className="muted">{store.country} marketplace{store.sellerId ? ` · Seller ${store.sellerId}` : ""}</span><small>Access expires: {dateLabel(store.accessExpiresAt)}</small>{refreshDays !== null && refreshDays <= 7 && <small className="warning">Refresh token expires in {Math.max(refreshDays, 0)} days — reconnect soon.</small>}{store.lastError && <small className="warning">{store.lastError}</small>}</div><div className="store-actions"><button className="secondary" onClick={() => onConnect(store)}>{store.status === "pending" || store.status === "error" ? "Connect store" : "Reconnect"}</button><button className="text-button" disabled={!store.refreshExpiresAt || refreshDays !== null && refreshDays <= 0} onClick={() => onRefresh(store)}>Get new access token</button><button className="remove-button" onClick={() => onRemove(store)}>Remove</button></div></article>;
  })}</div>;
}

function Admin({ token }: { token: string }) {
  const [users, setUsers] = useState<any[]>([]);
  const [stores, setStores] = useState<any[]>([]);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => { const [u, s] = await Promise.all([api("/admin/users", token), api("/admin/stores", token)]); setUsers(u); setStores(s); }, [token]);
  useEffect(() => { load().catch((e) => setMessage(e.message)); }, [load]);
  async function toggle(user: any) { await api(`/admin/users/${user.id}`, token, { method: "PATCH", body: JSON.stringify({ isActive: !user.isActive }) }); await load(); }
  async function reset(user: any) { const password = prompt("Enter a temporary password (12+ characters, upper/lowercase, number and symbol):"); if (!password) return; await api(`/admin/users/${user.id}`, token, { method: "PATCH", body: JSON.stringify({ password }) }); setMessage("Password reset. User must sign in and change it."); }
  return <><section className="panel"><div className="section-head"><div><h2>Users <span className="count">{users.length}</span></h2><p className="muted">Activate accounts or reset passwords.</p></div></div>{message && <p className="notice">{message}</p>}<div className="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Stores</th><th>Status</th><th>Actions</th></tr></thead><tbody>{users.map((u) => <tr key={u.id}><td><strong>{u.name}</strong><small>{u.email}</small></td><td>{u.role}</td><td>{u._count.stores}</td><td><span className={`badge ${u.isActive ? "connected" : "error"}`}>{u.isActive ? "Active" : "Inactive"}</span></td><td><button className="text-button" onClick={() => toggle(u)}>{u.isActive ? "Deactivate" : "Activate"}</button><button className="text-button" onClick={() => reset(u)}>Reset password</button></td></tr>)}</tbody></table></div></section><section className="panel"><h2>All stores <span className="count">{stores.length}</span></h2><div className="table-wrap"><table><thead><tr><th>Store</th><th>Owner</th><th>Region</th><th>Status</th><th>Refresh expires</th></tr></thead><tbody>{stores.map((s) => <tr key={s.id}><td>{s.label}</td><td>{s.user.email}</td><td>{s.country}</td><td>{s.status}</td><td>{dateLabel(s.refreshExpiresAt)}</td></tr>)}</tbody></table></div></section></>;
}
function Audit({ token }: { token: string }) {
  const [rows, setRows] = useState<Array<{
    id: string;
    action: string;
    createdAt: string;
    user?: { email: string } | null;
    store?: { label: string } | null;
    meta?: { phase?: string; reason?: string } | null;
  }>>([]);
  useEffect(() => { api("/admin/audit", token).then(setRows).catch(() => setRows([])); }, [token]);
  return <section className="panel"><h2>Recent activity</h2><div className="table-wrap"><table><thead><tr><th>Event</th><th>User</th><th>Store</th><th>Details</th><th>Time</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{row.action.replaceAll("_", " ")}</td><td>{row.user?.email ?? "System"}</td><td>{row.store?.label ?? "—"}</td><td>{row.meta?.reason ? <><strong>{row.meta.phase?.replaceAll("_", " ") ?? "Details"}</strong><small>{row.meta.reason}</small></> : "—"}</td><td>{dateLabel(row.createdAt)}</td></tr>)}</tbody></table></div></section>;
}
