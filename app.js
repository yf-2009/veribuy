const el = (id) => document.getElementById(id);

const state = {
  raw: [],
  filtered: [],
  coupon: null,
  alerts: [],
  wishlist: []
};

let supabase = null;

async function initSupabase() {
  try {
    const r = await fetch("/api/config");

    if (!r.ok) {
      console.warn("Supabase config route failed:", r.status);
      supabase = null;
      return;
    }

    const cfg = await r.json();

    if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) {
      console.warn("Missing Supabase env vars");
      supabase = null;
      return;
    }

    supabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  } catch (e) {
    console.warn("Supabase init failed:", e);
    supabase = null;
  }
}

function fmtUSD(n) {
  if (typeof n !== "number") return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function escapeHtml(s) {
  return (s ?? "").toString()
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeLink(url, title = "") {
  if (!url) {
    return `https://www.google.com/search?q=${encodeURIComponent(title)}`;
  }

  try {
    const parsed = new URL(url);

    // If SerpAPI/Google gives a google shopping redirect, still allow it
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }

    return `https://www.google.com/search?q=${encodeURIComponent(title)}`;
  } catch {
    return `https://www.google.com/search?q=${encodeURIComponent(title)}`;
  }
}

async function signUp() {
  const email = el("authEmail")?.value.trim();
  const password = el("authPassword")?.value.trim();

  if (!email || !password) {
    el("authOut").textContent = "Enter email and password.";
    return;
  }

  const { error } = await supabase.auth.signUp({ email, password });
  el("authOut").textContent = error ? error.message : "Account created. You can log in now.";
}

async function signIn() {
  const email = el("authEmail")?.value.trim();
  const password = el("authPassword")?.value.trim();

  if (!email || !password) {
    el("authOut").textContent = "Enter email and password.";
    return;
  }

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  el("authOut").textContent = error ? error.message : "Logged in.";
  await refreshAuthUI();
  await loadWishlistFromSupabase();
}

async function signOut() {
  await supabase.auth.signOut();
  state.wishlist = [];
  renderWishlist();
  await refreshAuthUI();
}

async function getCurrentUser() {
  const { data } = await supabase.auth.getUser();
  return data?.user || null;
}

async function refreshAuthUI() {
  const user = await getCurrentUser();

  if (!user) {
    el("authOut").textContent = "Not logged in.";
    if (el("subscribedToggle")) el("subscribedToggle").checked = true;
    return;
  }

  el("authOut").textContent = `Logged in as ${user.email}`;

  const { data } = await supabase
    .from("profiles")
    .select("subscribed")
    .eq("id", user.id)
    .single();

  if (data && el("subscribedToggle")) {
    el("subscribedToggle").checked = !!data.subscribed;
  }
}

async function saveSubscriptionPreference() {
  const user = await getCurrentUser();
  if (!user) {
    alert("Please log in first.");
    return;
  }

  const subscribed = !!el("subscribedToggle")?.checked;

  const { error } = await supabase
    .from("profiles")
    .update({ subscribed })
    .eq("id", user.id);

  if (error) {
    alert(error.message);
    return;
  }

  el("authOut").textContent = subscribed
    ? "Subscription preference saved: subscribed."
    : "Subscription preference saved: unsubscribed.";
}

function setStatus(text, tone = "neutral") {
  const pill = el("statusPill");
  if (!pill) return;
  pill.textContent = text;

  const styles = {
    neutral: ["rgba(255,255,255,.14)","rgba(255,255,255,.05)","rgba(255,255,255,.70)"],
    good: ["rgba(54,211,153,.35)","rgba(54,211,153,.10)","rgba(240,255,250,.92)"],
    warn: ["rgba(251,191,36,.35)","rgba(251,191,36,.10)","rgba(255,250,235,.92)"],
    bad:  ["rgba(251,113,133,.35)","rgba(251,113,133,.10)","rgba(255,240,244,.92)"]
  }[tone] || ["rgba(255,255,255,.14)","rgba(255,255,255,.05)","rgba(255,255,255,.70)"];

  pill.style.borderColor = styles[0];
  pill.style.background = styles[1];
  pill.style.color = styles[2];
}

function isMajorRetailer(source) {
  const s = (source || "").toLowerCase();
  const majors = ["sephora","ulta","target","walmart","amazon","cvs","walgreens","macys","kohls"];
  return majors.some(m => s.includes(m));
}

function trustSignal(item, strict = true) {
  const hasRating = typeof item.rating === "number";
  const reviews = typeof item.reviews === "number" ? item.reviews : 0;

  let score = 72;
  const reasons = [];

  if (isMajorRetailer(item.source)) score += 10;
  else { score -= 5; reasons.push("Non-major seller"); }

  if (!hasRating) { score -= strict ? 12 : 6; reasons.push("No rating signal"); }

  if (reviews === 0) { score -= strict ? 14 : 7; reasons.push("No review count"); }
  else if (reviews < 20) { score -= strict ? 9 : 5; reasons.push("Low review volume"); }
  else if (reviews > 300) score += 6;

  score = Math.max(0, Math.min(100, score));

  let tag = "Verified", tone = "good";
  if (score < 70) { tag = "Mixed"; tone = "warn"; }
  if (score < 55) { tag = "Flagged"; tone = "bad"; }

  return { score, tag, tone, reasons };
}

function bestValueScore(item, trustScore) {
  const p = typeof item.price === "number" ? item.price : 999;
  const priceComponent = Math.max(0, 120 - p * 5);
  return priceComponent * 0.55 + trustScore * 0.45;
}

function applyFilters() {
  const maxPrice = Number(el("maxPrice")?.value || 999999);
  const minRating = Number(el("minRating")?.value || 0);
  const sortBy = el("sortBy")?.value || "bestValue";
  const strict = !!el("strictTrust")?.checked;
  const preferMajor = !!el("preferMajor")?.checked;

  let items = [...state.raw];
    
    const onlySephora = !!el("onlySephora")?.checked;
  if (onlySephora) {
    items = items.filter(it => (it.source || "").toLowerCase().includes("sephora"));
  }


  items = items.filter(it => {
    const pOk = typeof it.price !== "number" ? true : it.price <= maxPrice;
    const rOk = typeof it.rating !== "number" ? (minRating === 0) : it.rating >= minRating;
    return pOk && rOk;
  });

  if (preferMajor) {
    items.sort((a, b) => (isMajorRetailer(b.source) ? 1 : 0) - (isMajorRetailer(a.source) ? 1 : 0));
  }

  items.sort((a, b) => {
    const ta = trustSignal(a, strict).score;
    const tb = trustSignal(b, strict).score;

    if (sortBy === "lowest") return (a.price ?? 999) - (b.price ?? 999);
    if (sortBy === "highest") return (b.rating ?? 0) - (a.rating ?? 0);
    if (sortBy === "mostReviews") return (b.reviews ?? 0) - (a.reviews ?? 0);

    return bestValueScore(b, tb) - bestValueScore(a, ta);
  });

  state.filtered = items;
  renderResults();
  renderCompare();
}

function aspectScore(trust, offset) {
  const base = 3.6 + (trust / 100) * 1.2;
  const v = Math.max(3.5, Math.min(4.9, base + (offset - 1.5) * 0.08));
  return v.toFixed(1);
}

function renderResults() {
  const out = el("results");
  const meta = el("resultsMeta");
  if (!out) return;

  meta && (meta.textContent = `${state.filtered.length} items`);

  if (!state.filtered.length) {
    out.innerHTML = `<div class="small">No results yet. Try a search above.</div>`;
    return;
  }

  const strict = !!el("strictTrust")?.checked;

  out.innerHTML = state.filtered.map((it, idx) => {
    const t = trustSignal(it, strict);

    const discounted = (state.coupon && typeof it.price === "number")
      ? Math.max(0, it.price - state.coupon.amount)
      : null;

    const priceLine = discounted !== null
      ? `<div class="price">${fmtUSD(discounted)} <span class="small">after coupon</span></div>`
      : `<div class="price">${fmtUSD(it.price)} <span class="small">${it.priceText ? "" : "price n/a"}</span></div>`;

    const ratingText = (typeof it.rating === "number") ? `${it.rating.toFixed(1)}★` : "—";
    const reviewsText = (typeof it.reviews === "number") ? `${it.reviews} reviews` : "reviews n/a";
    const reason = t.reasons?.[0] ? `<span class="badge warn">${escapeHtml(t.reasons[0])}</span>` : `<span class="badge">No flags</span>`;
    const major = isMajorRetailer(it.source) ? `<span class="badge brand">Major retailer</span>` : `<span class="badge">Marketplace</span>`;

    const img = it.thumbnail ? `<img alt="" src="${it.thumbnail}" />` : "";

    const trustCls = t.tone === "good" ? "good" : t.tone === "warn" ? "warn" : "bad";

    return `
      <article class="prod">
        <div class="thumb" aria-hidden="true">${img}</div>

        <div>
          <h5>${escapeHtml(it.title)}</h5>
          <div class="meta">
            Source: <b>${escapeHtml(it.source || "Unknown")}</b> · Rating: <b>${ratingText}</b> · ${escapeHtml(reviewsText)}
          </div>

          <div class="row">
            <div class="badges">
              <span class="badge ${trustCls}">${t.tag}: ${t.score}/100</span>
              ${reason}
              ${major}
            </div>
            ${priceLine}
          </div>

          <div class="row" style="margin-top:10px;">
            <div class="small">
              Multi-aspect (demo): Value <b>${aspectScore(t.score, 2)}</b> · Longevity <b>${aspectScore(t.score, 1)}</b> · Comfort <b>${aspectScore(t.score, 3)}</b> · Pigmentation <b>${aspectScore(t.score, 0)}</b>
            </div>

            <div style="display:flex; gap:8px; flex-wrap:wrap;">
                      
            <button class="btn" data-wish="${idx}">Save</button>
            <button class="btn" data-history="${idx}">History</button>
            <button class="btn" data-reviews="${idx}">See Reviews</button>
            <a class="btn" href="${safeLink(it.link, it.title)}" target="_blank" rel="noopener noreferrer">View ↗</a>
          </div>
          
          <div id="reviews-${idx}" class="small" style="margin-top:10px; display:none;"></div>

          </div>
        </div>
      </article>
    `;
  }).join("");
  
    out.querySelectorAll("[data-wish]").forEach(btn => {
    btn.addEventListener("click", () => addToWishlist(Number(btn.getAttribute("data-wish"))));
  });
  
  out.querySelectorAll("[data-history]").forEach(btn => {
    btn.addEventListener("click", () => showHistory(Number(btn.getAttribute("data-history"))));
  });
  
  out.querySelectorAll("[data-reviews]").forEach(btn => {
    btn.addEventListener("click", () => showReviews(Number(btn.getAttribute("data-reviews"))));
  });
}

function renderCompare() {
  const body = el("compareBody");
  if (!body) return;

  const strict = !!el("strictTrust")?.checked;
  const top = state.filtered.slice(0, 8);

  if (!top.length) {
    body.innerHTML = `<tr><td colspan="4">No results yet.</td></tr>`;
    return;
  }

  body.innerHTML = top.map(it => {
    const t = trustSignal(it, strict);
    const trustLabel = t.tone === "good" ? "Trusted" : t.tone === "warn" ? "Mixed" : "Flagged";
    const coupon = state.coupon ? (state.coupon.verified ? "Verified applied" : "Unverified") : "—";
    return `
      <tr>
        <td><b>${escapeHtml(it.source || "Unknown")}</b></td>
        <td>${fmtUSD(it.price)}</td>
        <td>${trustLabel} (${t.score}/100)</td>
        <td>${coupon}</td>
      </tr>
    `;
  }).join("");
}

/* Wishlist */
async function addToWishlist(filteredIndex) {
  const item = state.filtered[filteredIndex];
  if (!item) return;

  const user = await getCurrentUser();
  if (!user) {
    alert("Please log in to save products.");
    return;
  }

  const productKey = `${(item.title || "").toLowerCase()}::${(item.source || "").toLowerCase()}`;

  const { error } = await supabase
    .from("wishlist")
    .upsert({
      user_id: user.id,
      product_key: productKey,
      title: item.title,
      source: item.source,
      link: item.link,
      thumbnail: item.thumbnail,
      price: item.price
    }, { onConflict: "user_id,product_key" });

  if (error) {
    alert(error.message);
    return;
  }

  await loadWishlistFromSupabase();
}

async function removeWishlist(key) {
  const user = await getCurrentUser();
  if (!user) return;

  const { error } = await supabase
    .from("wishlist")
    .delete()
    .eq("id", key)
    .eq("user_id", user.id);

  if (error) {
    alert(error.message);
    return;
  }

  await loadWishlistFromSupabase();
}

async function loadWishlistFromSupabase() {
  const user = await getCurrentUser();

  if (!user) {
    state.wishlist = [];
    renderWishlist();
    return;
  }

  const { data, error } = await supabase
    .from("wishlist")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error(error);
    return;
  }

  state.wishlist = (data || []).map(w => ({
    _k: w.id,
    title: w.title,
    source: w.source,
    link: w.link,
    thumbnail: w.thumbnail,
    price: w.price
  }));

  renderWishlist();
}

function renderWishlist() {
  const out = el("wishlistOut");
  if (!out) return;

  if (!state.wishlist.length) {
    out.textContent = "No saved items yet.";
    return;
  }

  out.innerHTML = state.wishlist.slice(0, 8).map(w => `
    <div style="display:flex; justify-content:space-between; gap:10px; align-items:center; margin:6px 0;">
      <div>
        <b>${escapeHtml(w.title)}</b>
        <div class="small">${escapeHtml(w.source || "Unknown")} · ${fmtUSD(w.price)}</div>
      </div>
      <div style="display:flex; gap:8px;">
        <a class="btn" href="${safeLink(w.link, w.title)}" target="_blank" rel="noopener noreferrer">Open ↗</a>
        <button class="btn" data-rm="${escapeHtml(w._k)}">Remove</button>
      </div>
    </div>
  `).join("");

  out.querySelectorAll("[data-rm]").forEach(btn => {
    btn.addEventListener("click", () => removeWishlist(btn.getAttribute("data-rm")));
  });
}

/* Coupon demo */
function applyCoupon(code) {
  const c = (code || "").trim().toUpperCase();
  const out = el("couponOut");

  if (!c) {
    state.coupon = null;
    out && (out.textContent = "Enter a code to see verified/unverified behavior.");
    applyFilters();
    return;
  }

  const rules = {
    "VERIBUY5": { amount: 0.75, verified: true, msg: "Verified coupon applied (demo)." },
    "WELCOME":  { amount: 0.50, verified: true, msg: "Verified welcome coupon applied (demo)." },
    "SAVE10":   { amount: 1.00, verified: false, msg: "Found, but not verified for all sellers (demo)." }
  };

  const coupon = rules[c];
  if (!coupon) {
    state.coupon = { amount: 0.0, verified: false, code: c };
    out && (out.textContent = `Code "${c}" not found (demo).`);
    applyFilters();
    return;
  }

  state.coupon = { ...coupon, code: c };
  out && (out.textContent = `${coupon.msg} Discount: $${coupon.amount.toFixed(2)}`);
  applyFilters();
}

/* Alerts */
function saveAlert() {
  const name = (el("alertName")?.value || "").trim();
  if (!name) return;

  const maxPrice = Number(el("maxPrice")?.value || 999999);
  const minRating = Number(el("minRating")?.value || 0);
  const strict = !!el("strictTrust")?.checked;

  const id = (globalThis.crypto?.randomUUID?.() || String(Date.now()));
  state.alerts.unshift({ id, name, maxPrice, minRating, strict, createdAt: new Date().toISOString() });

  el("alertName").value = "";
  renderAlerts();
}

function removeAlert(id) {
  state.alerts = state.alerts.filter(a => a.id !== id);
  renderAlerts();
}

function renderAlerts() {
  const out = el("alertsOut");
  if (!out) return;

  if (!state.alerts.length) {
    out.textContent = "No alerts saved yet.";
    return;
  }

  out.innerHTML = state.alerts.slice(0, 6).map(a => {
    const when = new Date(a.createdAt).toLocaleString("en-US", { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" });
    return `
      <div style="display:flex; justify-content:space-between; gap:10px; align-items:center; margin:6px 0;">
        <div>
          <b>${escapeHtml(a.name)}</b>
          <div class="small">max ${fmtUSD(a.maxPrice)} · min rating ${a.minRating || "Any"} · ${a.strict ? "Strict trust" : "Standard"} · ${when}</div>
        </div>
        <button class="btn" data-alert-rm="${escapeHtml(a.id)}">Remove</button>
      </div>
    `;
  }).join("");

  out.querySelectorAll("[data-alert-rm]").forEach(btn => {
    btn.addEventListener("click", () => removeAlert(btn.getAttribute("data-alert-rm")));
  });
}

/* Price history demo */
function showHistory(filteredIndex) {
  const it = state.filtered[filteredIndex];
  if (!it) return;

  const out = el("historyOut");
  if (!out) return;

  const p = (typeof it.price === "number" ? it.price : 18.0);
  const points = generateHistory(p);

  out.innerHTML = `
    <div class="small" style="margin-bottom:8px;">
      History for: <b>${escapeHtml(it.title)}</b> (${escapeHtml(it.source || "Unknown")})
    </div>
    <table class="table">
      <thead><tr><th>Date</th><th>Price</th><th>Signal</th></tr></thead>
      <tbody>
        ${points.map(pt => `<tr><td>${pt.date}</td><td><b>${fmtUSD(pt.price)}</b></td><td>${pt.note}</td></tr>`).join("")}
      </tbody>
    </table>
  `;

  const details = out.closest("details");
  if (details) details.open = true;
}

async function showReviews(filteredIndex) {
  const item = state.filtered[filteredIndex];
  const box = document.getElementById(`reviews-${filteredIndex}`);
  if (!item || !box) return;

  if (box.style.display === "block") {
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }

  const productKey = `${(item.title || "").toLowerCase()}::${(item.source || "").toLowerCase()}`;

  const { data, error } = await supabase
    .from("product_reviews")
    .select("id, user_id, rating, comment_text, created_at")
    .eq("product_key", productKey)
    .order("created_at", { ascending: false });

  if (error) {
    box.innerHTML = `<div class="panel mini">Could not load reviews.</div>`;
    box.style.display = "block";
    return;
  }

  box.innerHTML = `
    <div class="panel mini">
      <h4 style="margin-bottom:8px;">Reviews for ${escapeHtml(item.title)}</h4>

      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px;">
        <select id="review-rating-${filteredIndex}" class="input" style="max-width:140px;">
          <option value="5">5 stars</option>
          <option value="4">4 stars</option>
          <option value="3">3 stars</option>
          <option value="2">2 stars</option>
          <option value="1">1 star</option>
        </select>
        <button class="btn" data-submit-review="${filteredIndex}">Post Review</button>
      </div>

      <textarea id="review-text-${filteredIndex}" class="input" rows="3" placeholder="Write your review here"></textarea>

      <div id="review-list-${filteredIndex}" style="margin-top:12px;">
        ${
          (data || []).length
            ? data.map(r => `
              <div style="margin-bottom:10px; padding:10px; border-radius:12px; background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.08);">
                <div><b>${escapeHtml(String(r.rating))}/5</b> · ${new Date(r.created_at).toLocaleDateString()}</div>
                <div style="margin-top:4px;">${escapeHtml(r.comment_text)}</div>
              </div>
            `).join("")
            : `<div class="small">No reviews yet.</div>`
        }
      </div>
    </div>
  `;

  box.style.display = "block";

  box.querySelector(`[data-submit-review="${filteredIndex}"]`)?.addEventListener("click", async () => {
    await submitReview(filteredIndex);
  });
}

async function submitReview(filteredIndex) {
  const item = state.filtered[filteredIndex];
  if (!item) return;

  const user = await getCurrentUser();
  if (!user) {
    alert("Please log in to leave a review.");
    return;
  }

  const rating = Number(document.getElementById(`review-rating-${filteredIndex}`)?.value || 5);
  const commentText = document.getElementById(`review-text-${filteredIndex}`)?.value.trim();

  if (!commentText) {
    alert("Write a review first.");
    return;
  }

  const productKey = `${(item.title || "").toLowerCase()}::${(item.source || "").toLowerCase()}`;

  const { error } = await supabase
    .from("product_reviews")
    .insert({
      user_id: user.id,
      product_key: productKey,
      product_title: item.title,
      rating,
      comment_text: commentText
    });

  if (error) {
    alert(error.message);
    return;
  }

  await showReviews(filteredIndex);
}

function generateHistory(currentPrice) {
  const notes = ["Stable","Small dip","Small rise","Promo week","Low stock","Weekend drop","Restock","Trending"];
  const arr = [];
  const today = new Date();
  let p = currentPrice;

  for (let i = 7; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i * 7);

    const drift = (Math.random() - 0.5) * 1.8;
    p = Math.max(4, p + drift);

    arr.push({
      date: d.toLocaleDateString("en-US", { month:"short", day:"numeric" }),
      price: Number(p.toFixed(2)),
      note: notes[(7 - i) % notes.length]
    });
  }
  return arr;
}

/* Live search */
async function runSearch(query) {
  const q = (query || "").trim();
  if (!q) return;

  el("q").value = q;
  setStatus("Searching live prices…", "warn");

  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await r.json();

    if (!r.ok) {
      setStatus("Search error", "bad");
      alert(data?.error || data?.detail || "Search failed");
      return;
    }

    state.raw = Array.isArray(data.items) ? data.items : [];
    setStatus(`Live results loaded (${state.raw.length})`, "good");

    applyFilters();
  } catch (e) {
    setStatus("Network error", "bad");
    alert("Network error. Check Vercel deploy.\n\n" + String(e));
  }
}

/* Init */
async function init() {
  const y = document.getElementById("y");
  if (y) y.textContent = String(new Date().getFullYear());

  await initSupabase();

  el("btnSearch")?.addEventListener("click", () => runSearch(el("q").value));
  el("q")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch(el("q").value);
  });

  document.querySelectorAll("[data-q]").forEach(btn => {
    btn.addEventListener("click", () => runSearch(btn.getAttribute("data-q")));
  });

  ["maxPrice","minRating","sortBy","strictTrust","preferMajor","onlySephora"].forEach(id => {
    el(id)?.addEventListener("change", applyFilters);
    el(id)?.addEventListener("input", applyFilters);
  });

  el("btnApplyCoupon")?.addEventListener("click", () => applyCoupon(el("couponCode").value));
  el("couponCode")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") applyCoupon(el("couponCode").value);
  });

  el("btnSaveAlert")?.addEventListener("click", saveAlert);

  el("btnSignUp")?.addEventListener("click", signUp);
  el("btnSignIn")?.addEventListener("click", signIn);
  el("btnSignOut")?.addEventListener("click", signOut);
  el("btnSaveSubscription")?.addEventListener("click", saveSubscriptionPreference);

  if (supabase) {
    supabase.auth.onAuthStateChange(async () => {
      await refreshAuthUI();
      await loadWishlistFromSupabase();
    });

    await refreshAuthUI();
    await loadWishlistFromSupabase();
  } else {
    const authOut = el("authOut");
    if (authOut) authOut.textContent = "Account system not configured yet.";
    renderWishlist();
  }

  renderAlerts();
  runSearch("matte lipstick under $15");
}

init();
