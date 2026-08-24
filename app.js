/* ============================================================================
   Terra Foods Portal — application logic
   One file, matching the original two tools' single-file convention.
   Sections:
     1. Firebase init
     2. Small utilities (toast, modals, formatting, CSV, animation)
     3. Auth + role gating
     4. Real-time data layer (Firestore listeners + writes)
     5. Navigation / view switching
     6. Dashboard rendering
     7. Products + Add Product
     8. Record Sale / Purchase / Adjustments
     9. Update Expiry Dates
     10. Clients & Suppliers
     11. Reports
     12. Users (role-scoped)
     13. Backup & Settings (CSV import/export, wipe)
     14. Boot
   ============================================================================ */

import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, updatePassword, browserLocalPersistence, setPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  collection, query, where, orderBy, onSnapshot, runTransaction, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

/* ============================== 1. FIREBASE INIT ============================== */

const firebaseConfig = window.TERRA_FIREBASE_CONFIG;
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);
setPersistence(auth, browserLocalPersistence).catch(()=>{});

const PLACEHOLDER_DATE = "2027-01-01";
const EXPIRY_WARNING_DAYS = 30;
const ROLE_LABELS = { admin:"Admin", manager:"Manager", staff:"Staff", viewer:"Viewer" };

let currentUser = null; // { uid, email, displayName, role, active }

/* ============================== 2. UTILITIES ============================== */

function fmtMoney(n){ n = Math.round(n||0); return "₹" + n.toLocaleString("en-IN"); }
function fmtNum(n){ return Number(n||0).toLocaleString("en-IN"); }
function todayISO(){ const d=new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }
function escapeHtml(s){ return String(s==null?"":s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

const ICONS = {
  success:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-6"/></svg>',
  error:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v5M12 16h.01"/></svg>',
  info:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-5M12 8h.01"/></svg>'
};

function toast(kind, message){
  const stack = document.getElementById("toastStack");
  const el = document.createElement("div");
  el.className = "toast " + (kind==="error"?"error":kind==="success"?"success":"");
  el.innerHTML = (ICONS[kind]||ICONS.info) + "<span>"+escapeHtml(message)+"</span><button class=\"close-toast\" aria-label=\"Dismiss\">×</button>";
  stack.appendChild(el);
  const remove = ()=>{ el.classList.add("leaving"); setTimeout(()=>el.remove(), 200); };
  el.querySelector(".close-toast").addEventListener("click", remove);
  setTimeout(remove, 5200);
}

function showConfirm({title, body, okLabel="Confirm", danger=true, requireText=null}){
  return new Promise((resolve)=>{
    const overlay = document.getElementById("confirmModal");
    document.getElementById("confirmModalTitle").textContent = title;
    document.getElementById("confirmModalBody").textContent = body;
    const okBtn = document.getElementById("confirmModalOk");
    const cancelBtn = document.getElementById("confirmModalCancel");
    const typeInput = document.getElementById("confirmTypeInput");
    okBtn.textContent = okLabel;
    okBtn.className = "btn " + (danger?"danger":"");
    if(requireText){
      typeInput.classList.remove("hidden");
      typeInput.value = "";
      typeInput.placeholder = 'Type "' + requireText + '" to confirm';
      okBtn.disabled = true;
    } else {
      typeInput.classList.add("hidden");
      okBtn.disabled = false;
    }
    function onInput(){ okBtn.disabled = requireText ? (typeInput.value !== requireText) : false; }
    typeInput.addEventListener("input", onInput);
    function cleanup(result){
      overlay.classList.remove("show");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      typeInput.removeEventListener("input", onInput);
      resolve(result);
    }
    function onOk(){ cleanup(true); }
    function onCancel(){ cleanup(false); }
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    overlay.classList.add("show");
  });
}

function openModal(id){ document.getElementById(id).classList.add("show"); }
function closeModal(id){ document.getElementById(id).classList.remove("show"); }
document.querySelectorAll(".modal-overlay").forEach(ov=>{
  ov.addEventListener("click", (e)=>{
    if(e.target !== ov) return;
    // confirmModal is promise-based (showConfirm) — clicking outside must go through
    // its real Cancel button so the pending promise resolves and listeners clean up,
    // instead of just hiding the overlay and leaving the promise hanging forever.
    if(ov.id === "confirmModal") document.getElementById("confirmModalCancel").click();
    else ov.classList.remove("show");
  });
});

function animateCount(el, target, {money=false} = {}){
  const start = Number(el.dataset.rawValue || 0);
  const end = Number(target) || 0;
  el.dataset.rawValue = end;
  const duration = 550;
  const t0 = performance.now();
  function tick(now){
    const p = Math.min(1, (now - t0) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    const val = start + (end - start) * eased;
    el.textContent = money ? fmtMoney(val) : fmtNum(Math.round(val));
    if(p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function csvEscape(v){
  v = (v===undefined||v===null) ? "" : String(v);
  if(/[",\n]/.test(v)) return '"' + v.replace(/"/g,'""') + '"';
  return v;
}
function toCsv(headers, rows){
  const lines = [headers.map(csvEscape).join(",")];
  for(const row of rows) lines.push(row.map(csvEscape).join(","));
  return lines.join("\n");
}
function downloadText(filename, text, mime="text/csv"){
  const blob = new Blob([text], {type: mime + ";charset=utf-8;"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 2000);
}
function parseCsv(text){
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for(let i=0;i<text.length;i++){
    const c = text[i];
    if(inQuotes){
      if(c === '"'){
        if(text[i+1] === '"'){ field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else {
      if(c === '"') inQuotes = true;
      else if(c === ','){ row.push(field); field = ""; }
      else if(c === '\n' || c === '\r'){
        if(field.length || row.length){ row.push(field); rows.push(row); row=[]; field=""; }
        if(c === '\r' && text[i+1] === '\n') i++;
      } else field += c;
    }
  }
  if(field.length || row.length){ row.push(field); rows.push(row); }
  return rows;
}

function diffDaysFromToday(dateStr){
  if(!dateStr) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const d = new Date(dateStr + "T00:00:00");
  if(isNaN(d.getTime())) return null; // malformed date string — don't silently compare against NaN
  return Math.round((d - today) / 86400000);
}

// Every expiry date is meant to be stored as ISO (YYYY-MM-DD) — that's what <input type="date">
// always yields, and it's the only format diffDaysFromToday() understands. A CSV re-exported
// from Excel/Sheets often re-formats a date column to the locale's short format instead
// (e.g. "3/31/2026"), which then sits in Firestore looking fine but silently never counts as
// "expiring soon" since date math on it produces NaN. This normalizes on the way in.
function normalizeExpiryDate(raw){
  if(!raw) return raw; // blank stays blank — nothing to normalize
  const s = String(raw).trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; // already ISO
  // M/D/YYYY or MM/DD/YYYY — the common Excel/Sheets CSV export format
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if(m){
    const month = m[1].padStart(2,"0"), day = m[2].padStart(2,"0"), year = m[3];
    const iso = `${year}-${month}-${day}`;
    return isNaN(new Date(iso+"T00:00:00").getTime()) ? null : iso;
  }
  return null; // unrecognized format — caller decides how to handle
}

/* ============================== 3. AUTH + ROLE GATING ============================== */

const loginScreen = document.getElementById("loginScreen");
const appShell = document.getElementById("appShell");

document.getElementById("loginForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errBox = document.getElementById("loginError");
  const btn = document.getElementById("loginSubmitBtn");
  errBox.classList.remove("show");
  btn.disabled = true;
  try{
    await signInWithEmailAndPassword(auth, email, password);
  }catch(err){
    errBox.textContent = friendlyAuthError(err);
    errBox.classList.add("show");
  }finally{
    btn.disabled = false;
  }
});

function friendlyAuthError(err, context="sign in"){
  const code = err && err.code || "";
  if(code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) return "That email or password isn't right.";
  if(code.includes("email-already-in-use")) return "There's already an account with that email.";
  if(code.includes("weak-password")) return "That password is too weak — use at least 6 characters.";
  if(code.includes("invalid-email")) return "That email address doesn't look valid.";
  if(code.includes("too-many-requests")) return "Too many attempts — please wait a bit and try again.";
  if(code.includes("network")) return "Network problem — check your connection and try again.";
  return "Couldn't " + context + ": " + (err.message || "unknown error");
}

document.getElementById("logoutBtn").addEventListener("click", async ()=>{
  await signOut(auth);
});

document.getElementById("changePasswordBtn").addEventListener("click", ()=>{
  document.getElementById("newPasswordInput").value = "";
  openModal("changePasswordModal");
});
document.getElementById("changePasswordCancel").addEventListener("click", ()=>closeModal("changePasswordModal"));
document.getElementById("changePasswordSave").addEventListener("click", async ()=>{
  const pw = document.getElementById("newPasswordInput").value;
  if(pw.length < 6){ toast("error","Password should be at least 6 characters."); return; }
  try{
    await updatePassword(auth.currentUser, pw);
    toast("success","Password updated.");
    closeModal("changePasswordModal");
  }catch(err){
    if((err.code||"").includes("requires-recent-login")){
      toast("error","For security, please sign out and sign back in, then try changing your password again.");
    } else {
      toast("error","Couldn't update password: " + err.message);
    }
  }
});

document.getElementById("weeklyReportBtn").addEventListener("click", ()=>{
  document.getElementById("weeklyReportOptIn").checked = !!currentUser.weeklyReportOptIn;
  document.getElementById("weeklyReportDay").value = currentUser.weeklyReportDay || "monday";
  document.getElementById("weeklyReportFlash").className = "flash";
  openModal("weeklyReportModal");
});
document.getElementById("weeklyReportCancel").addEventListener("click", ()=>closeModal("weeklyReportModal"));
document.getElementById("weeklyReportSave").addEventListener("click", async ()=>{
  const optIn = document.getElementById("weeklyReportOptIn").checked;
  const day = document.getElementById("weeklyReportDay").value;
  try{
    await updateDoc(doc(db,"users",currentUser.uid), { weeklyReportOptIn: optIn, weeklyReportDay: day });
    currentUser.weeklyReportOptIn = optIn;
    currentUser.weeklyReportDay = day;
    toast("success", optIn ? `You'll get weekly reports every ${day.charAt(0).toUpperCase()+day.slice(1)}.` : "Weekly reports turned off.");
    closeModal("weeklyReportModal");
  }catch(err){ toast("error","Couldn't save: "+err.message); }
});
document.getElementById("sendTestReportBtn").addEventListener("click", async ()=>{
  const btn = document.getElementById("sendTestReportBtn");
  const flash = document.getElementById("weeklyReportFlash");
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Sending…";
  flash.className = "flash";
  try{
    const sendTest = httpsCallable(functions, "sendTestReportEmail");
    const result = await sendTest();
    flash.className = "flash show success";
    flash.textContent = (result.data && result.data.message) || `Test email sent to ${currentUser.email}.`;
  }catch(err){
    flash.className = "flash show error";
    flash.textContent = "Couldn't send test email: " + (err.message || "unknown error");
  }finally{
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

let unsubscribers = [];
function teardownListeners(){
  unsubscribers.forEach(u=>u());
  unsubscribers = [];
}

onAuthStateChanged(auth, async (user)=>{
  teardownListeners();
  if(!user){
    currentUser = null;
    appShell.classList.add("hidden");
    loginScreen.classList.remove("hidden");
    return;
  }
  try{
    const snap = await getDoc(doc(db, "users", user.uid));
    if(!snap.exists() || snap.data().active === false){
      toast("error","Your account isn't active. Please contact your Admin or Manager.");
      await signOut(auth);
      return;
    }
    currentUser = { uid:user.uid, email:user.email, ...snap.data() };
    loginScreen.classList.add("hidden");
    appShell.classList.remove("hidden");
    document.getElementById("sideRoleLabel").textContent = ROLE_LABELS[currentUser.role] || currentUser.role;
    document.getElementById("currentUserLabel").textContent = currentUser.displayName || currentUser.email;
    applyRoleVisibility();
    setDefaultDates();
    startListeners();
  }catch(err){
    toast("error","Couldn't load your profile: " + err.message);
    await signOut(auth);
  }
});

function applyRoleVisibility(){
  const role = currentUser.role;
  document.querySelectorAll("[data-roles]").forEach(el=>{
    const allowed = el.dataset.roles.split(",");
    el.classList.toggle("hidden", !allowed.includes(role));
  });
  document.getElementById("productsEditHint").textContent =
    (role==="admin"||role==="manager") ? "click a value to edit" : "read-only";
  document.getElementById("usersHint").textContent =
    role==="admin" ? "you can manage every role" : "you can manage Staff accounts only";
  // if the currently active view isn't allowed for this role, fall back to dashboard
  const activeView = document.querySelector(".view.active");
  if(activeView){
    const allowed = activeView.dataset.roles.split(",");
    if(!allowed.includes(role)) switchView("dashboard");
  }
}

function setDefaultDates(){
  const today = todayISO();
  ["saleDate","purchaseDate","adjustDate"].forEach(id=>{
    const el = document.getElementById(id);
    if(el && !el.value) el.value = today;
  });
  // Deliberately no default for purchaseExpiry — it must be entered by hand every time,
  // since it can never be corrected afterward once the purchase is saved.
}

/* ============================== 4. REAL-TIME DATA LAYER ============================== */

let products = [];   // cached, live-synced
let activity = [];   // cached, live-synced, newest first
let clients = [];
let suppliers = [];
let users = [];

function setSyncState(ok){
  const dot = document.getElementById("syncDot");
  const label = document.getElementById("syncLabel");
  if(!dot) return;
  dot.classList.toggle("offline", !ok);
  label.textContent = ok ? "Live" : "Reconnecting…";
}

function startListeners(){
  const productsQ = query(collection(db, "products"), orderBy("name"));
  unsubscribers.push(onSnapshot(productsQ, (snap)=>{
    products = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    setSyncState(true);
    refreshProductSelects();
    renderAll();
  }, (err)=>{ setSyncState(false); toast("error","Products sync error: "+err.message); }));

  const activityQ = query(collection(db, "activity"), orderBy("createdAt", "desc"));
  unsubscribers.push(onSnapshot(activityQ, (snap)=>{
    activity = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    setSyncState(true);
    renderAll();
  }, (err)=>{ setSyncState(false); toast("error","Activity sync error: "+err.message); }));

  const clientsQ = query(collection(db, "clients"), orderBy("name"));
  unsubscribers.push(onSnapshot(clientsQ, (snap)=>{
    clients = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    refreshPartyDatalists();
    renderAll();
  }, (err)=>{ toast("error","Clients sync error: "+err.message); }));

  const suppliersQ = query(collection(db, "suppliers"), orderBy("name"));
  unsubscribers.push(onSnapshot(suppliersQ, (snap)=>{
    suppliers = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    refreshPartyDatalists();
    renderAll();
  }, (err)=>{ toast("error","Suppliers sync error: "+err.message); }));

  if(currentUser.role === "admin" || currentUser.role === "manager"){
    const usersQ = query(collection(db, "users"), orderBy("createdAt", "desc"));
    unsubscribers.push(onSnapshot(usersQ, (snap)=>{
      users = snap.docs.map(d=>({ id:d.id, ...d.data() }));
      renderUsersTable();
    }, (err)=>{ toast("error","Users sync error: "+err.message); }));
  }
}

function activeProducts(){ return products.filter(p=>!p.archived); }
function activeClients(){ return clients.filter(c=>c.active!==false); }
function activeSuppliers(){ return suppliers.filter(s=>s.active!==false); }
function findProduct(id){ return products.find(p=>p.id===id) || null; }

function itemStatus(p){
  if((p.stock||0) === 0) return "out";
  if((p.stock||0) <= (p.reorderThreshold||0)) return "low";
  return "ok";
}
function statusTag(status){
  const map = { out:["out","Out"], low:["low","Low"], ok:["ok","OK"] };
  const [cls,label] = map[status];
  return '<span class="tag '+cls+'">'+label+'</span>';
}

/* ---- batch consumption (FIFO by nearest expiry) ---- */
function consumeBatches(batches, qty){
  const clone = (batches||[]).map(b=>({...b}));
  clone.sort((a,b)=>{
    const ad = a.expiryDate || "9999-99-99";
    const bd = b.expiryDate || "9999-99-99";
    return ad < bd ? -1 : ad > bd ? 1 : 0;
  });
  let remaining = qty;
  const result = [];
  for(const b of clone){
    if(remaining <= 0){ result.push(b); continue; }
    if(b.qty <= remaining){ remaining -= b.qty; /* fully consumed, dropped */ }
    else { result.push({...b, qty: b.qty - remaining}); remaining = 0; }
  }
  return result;
}

function actorFields(){
  return {
    actorUid: currentUser.uid,
    actorName: currentUser.displayName || currentUser.email,
    actorRole: currentUser.role
  };
}

/* ---- transactional writes ---- */
async function recordSale({productId, qty, price, party, date, note}){
  const productRef = doc(db, "products", productId);
  const activityRef = doc(collection(db, "activity"));
  await runTransaction(db, async (tx)=>{
    const snap = await tx.get(productRef);
    if(!snap.exists()) throw new Error("Product not found");
    const p = snap.data();
    tx.update(productRef, {
      stock: (p.stock||0) - qty,
      salesTotal: (p.salesTotal||0) + qty,
      batches: consumeBatches(p.batches, qty),
      updatedAt: serverTimestamp(), updatedBy: currentUser.uid
    });
    tx.set(activityRef, {
      type:"sale", productId, productName:p.name, qty, price,
      date, note: note||"", party: party||"",
      ...actorFields(), createdAt: serverTimestamp()
    });
  });
  if(party) await ensureParty("clients", party);
}

async function recordPurchase({productId, qty, price, vendor, date, expiryDate, note}){
  const productRef = doc(db, "products", productId);
  const activityRef = doc(collection(db, "activity"));
  await runTransaction(db, async (tx)=>{
    const snap = await tx.get(productRef);
    if(!snap.exists()) throw new Error("Product not found");
    const p = snap.data();
    const newBatches = (p.batches||[]).map(b=>({...b}));
    if(qty > 0) newBatches.push({ qty, expiryDate, purchaseDate: date || null });
    tx.update(productRef, {
      stock: (p.stock||0) + qty,
      purchaseTotal: (p.purchaseTotal||0) + qty,
      maxCost: Math.max(p.maxCost||p.cost||0, price),
      batches: newBatches,
      updatedAt: serverTimestamp(), updatedBy: currentUser.uid
    });
    tx.set(activityRef, {
      type:"purchase", productId, productName:p.name, qty, price,
      date, note: note||"", vendor: vendor||"", expiryDate: expiryDate||"",
      ...actorFields(), createdAt: serverTimestamp()
    });
  });
  if(vendor) await ensureParty("suppliers", vendor);
}

async function recordAdjustment({adjType, productId, qty, date, note}){
  const productRef = doc(db, "products", productId);
  const activityRef = doc(collection(db, "activity"));
  await runTransaction(db, async (tx)=>{
    const snap = await tx.get(productRef);
    if(!snap.exists()) throw new Error("Product not found");
    const p = snap.data();
    const fields = { updatedAt: serverTimestamp(), updatedBy: currentUser.uid };
    if(adjType === "sample"){
      fields.stock = (p.stock||0) + qty;
      fields.sampleTotal = (p.sampleTotal||0) + qty;
    } else {
      fields.stock = (p.stock||0) - qty;
      fields.batches = consumeBatches(p.batches, qty);
      if(adjType === "damage") fields.damageTotal = (p.damageTotal||0) + qty;
      if(adjType === "expired") fields.expiredTotal = (p.expiredTotal||0) + qty;
      if(adjType === "sampleSent") fields.sampleSentTotal = (p.sampleSentTotal||0) + qty;
    }
    tx.update(productRef, fields);
    tx.set(activityRef, {
      type:adjType, productId, productName:p.name, qty,
      date, note: note||"",
      ...actorFields(), createdAt: serverTimestamp()
    });
  });
}

/* undo / delete an activity entry — Admin only (enforced by Firestore rules too) */
async function undoActivityEntry(entry){
  const productRef = doc(db, "products", entry.productId);
  await runTransaction(db, async (tx)=>{
    const snap = await tx.get(productRef);
    if(snap.exists()){
      const p = snap.data();
      const fields = { updatedAt: serverTimestamp(), updatedBy: currentUser.uid };
      if(entry.type === "sale"){
        fields.stock = (p.stock||0) + entry.qty;
        fields.salesTotal = Math.max(0, (p.salesTotal||0) - entry.qty);
        fields.batches = [...(p.batches||[]), { qty: entry.qty, expiryDate: PLACEHOLDER_DATE, purchaseDate: null }];
      } else if(entry.type === "purchase"){
        fields.stock = (p.stock||0) - entry.qty;
        fields.purchaseTotal = Math.max(0, (p.purchaseTotal||0) - entry.qty);
        fields.batches = consumeBatches(p.batches, entry.qty);
      } else if(entry.type === "damage"){
        fields.stock = (p.stock||0) + entry.qty;
        fields.damageTotal = Math.max(0, (p.damageTotal||0) - entry.qty);
        fields.batches = [...(p.batches||[]), { qty: entry.qty, expiryDate: PLACEHOLDER_DATE, purchaseDate: null }];
      } else if(entry.type === "expired"){
        fields.stock = (p.stock||0) + entry.qty;
        fields.expiredTotal = Math.max(0, (p.expiredTotal||0) - entry.qty);
        fields.batches = [...(p.batches||[]), { qty: entry.qty, expiryDate: PLACEHOLDER_DATE, purchaseDate: null }];
      } else if(entry.type === "sample"){
        fields.stock = (p.stock||0) - entry.qty;
        fields.sampleTotal = Math.max(0, (p.sampleTotal||0) - entry.qty);
      } else if(entry.type === "sampleSent"){
        fields.stock = (p.stock||0) + entry.qty;
        fields.sampleSentTotal = Math.max(0, (p.sampleSentTotal||0) - entry.qty);
        fields.batches = [...(p.batches||[]), { qty: entry.qty, expiryDate: PLACEHOLDER_DATE, purchaseDate: null }];
      }
      tx.update(productRef, fields);
    }
  });
  await deleteDoc(doc(db, "activity", entry.id));
}

async function ensureParty(kind, name){
  const clean = name.trim();
  if(!clean) return;
  const list = kind==="clients" ? clients : suppliers;
  const exists = list.find(p=>p.name.toLowerCase()===clean.toLowerCase());
  if(exists) return;
  await addDoc(collection(db, kind), { name:clean, active:true, createdAt: serverTimestamp() });
}

/* ============================== 5. NAVIGATION ============================== */

const VIEW_TITLES = {
  dashboard:"Dashboard", products:"Products", "add-product":"Add Product",
  "record-sale":"Record Sale", "record-purchase":"Record Purchase", adjustments:"Adjustments",
  expiry:"Expiry Dates", parties:"Clients & Suppliers", reports:"Reports",
  users:"Users", settings:"Backup & Settings"
};

function canAccessView(viewId){
  const el = document.getElementById("view-"+viewId);
  if(!el) return false;
  return el.dataset.roles.split(",").includes(currentUser.role);
}

function switchView(viewId){
  if(!currentUser || !canAccessView(viewId)) return;
  document.querySelectorAll(".nav-item").forEach(b=>b.classList.toggle("active", b.dataset.view===viewId));
  document.querySelectorAll(".view").forEach(v=>v.classList.remove("active","fade-in"));
  const el = document.getElementById("view-"+viewId);
  el.classList.add("active","fade-in");
  document.getElementById("pageTitle").textContent = VIEW_TITLES[viewId] || "Terra Foods";
  closeMobileSidebar();
}

document.querySelectorAll("#sideNav .nav-item").forEach(btn=>{
  btn.addEventListener("click", ()=>switchView(btn.dataset.view));
});

function closeMobileSidebar(){
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("sidebarScrim").classList.remove("show");
}
document.getElementById("hamburgerBtn").addEventListener("click", ()=>{
  document.getElementById("sidebar").classList.add("open");
  document.getElementById("sidebarScrim").classList.add("show");
});
document.getElementById("sidebarScrim").addEventListener("click", closeMobileSidebar);

/* ---- theme toggle ---- */
(function initTheme(){
  const saved = localStorage.getItem("terraTheme");
  if(saved) document.documentElement.setAttribute("data-theme", saved);
})();
document.getElementById("themeToggle").addEventListener("click", ()=>{
  const current = document.documentElement.getAttribute("data-theme") ||
    (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("terraTheme", next);
});

function renderAll(){
  renderDashboard();
  renderProductsTable();
  renderExpiryView();
  renderClientsSuppliers();
}

/* ============================== 6. DASHBOARD ============================== */

function computeTotals(){
  let stockValue=0, salesValue=0, totalStockQty=0, reorderCount=0, damagedQty=0, damagedValue=0, expiredQty=0;
  for(const p of activeProducts()){
    const maxCost = p.maxCost || p.cost || 0;
    stockValue += (p.stock||0) * maxCost;
    salesValue += (p.salesTotal||0) * (p.price||0);
    totalStockQty += (p.stock||0);
    if((p.stock||0) <= (p.reorderThreshold||0)) reorderCount++;
    damagedQty += (p.damageTotal||0);
    damagedValue += (p.damageTotal||0) * maxCost;
    expiredQty += (p.expiredTotal||0); // historical, all-time — how much has ever been written off as expired (Reports/CSV use this; the dashboard KPI uses live batch data instead, see renderKPIs)
  }
  return { stockValue, salesValue, totalStockQty, reorderCount, damagedQty, damagedValue, expiredQty };
}

function computeExpiryStats(){
  const rows = [];
  for(const p of activeProducts()){
    for(const b of (p.batches||[])){
      if(!b.expiryDate || b.qty<=0) continue;
      const dd = diffDaysFromToday(b.expiryDate);
      if(dd===null) continue; // malformed/non-ISO date string — can't place it on the timeline, so skip rather than mis-sort it
      if(dd <= EXPIRY_WARNING_DAYS){
        rows.push({ productName:p.name, pack:p.pack, qty:b.qty, expiryDate:b.expiryDate, diffDays:dd,
          status: dd<0 ? "overdue" : "soon" });
      }
    }
  }
  rows.sort((a,b)=>a.diffDays-b.diffDays);
  const soonQty = rows.filter(r=>r.status==="soon").reduce((s,r)=>s+r.qty,0);
  const overdueQty = rows.filter(r=>r.status==="overdue").reduce((s,r)=>s+r.qty,0);
  return { rows, soonQty, overdueQty };
}

function computeSampleStats(){
  const rows = [];
  let receivedTotal = 0, sentTotal = 0;
  for(const p of activeProducts()){
    const received = p.sampleTotal||0;
    const sent = p.sampleSentTotal||0;
    receivedTotal += received;
    sentTotal += sent;
    if(received>0 || sent>0) rows.push({ productName:p.name, pack:p.pack, received, sent });
  }
  rows.sort((a,b)=>(b.received+b.sent)-(a.received+a.sent));
  return { rows, receivedTotal, sentTotal };
}

function renderTape(totals){
  const wrap = document.getElementById("tapeStrip");
  wrap.innerHTML = `
    <div class="item"><span class="label">Items Tracked</span><span class="val mono">${fmtNum(activeProducts().length)}</span></div>
    <div class="item"><span class="label">Stock Qty on Hand</span><span class="val mono">${fmtNum(totals.totalStockQty)}</span></div>
    <div class="item"><span class="label">Stock Value</span><span class="val mono">${fmtMoney(totals.stockValue)}</span></div>
    <div class="item"><span class="label">Reorder Alerts</span><span class="val mono">${fmtNum(totals.reorderCount)}</span></div>
  `;
}

function kpiCard(id, label, value, {warn=false, sub="", money=false} = {}){
  return `<div class="kpi-card ${warn?"warn":""}">
    <div class="label">${label}</div>
    <div class="value mono" id="${id}">0</div>
    ${sub ? `<div class="sub">${sub}</div>` : ""}
  </div>`;
}

function renderKPIs(totals, expiryStats, sampleStats){
  const grid = document.getElementById("kpiGrid");
  grid.innerHTML =
    kpiCard("kpiStockQty","Stock Qty on Hand", totals.totalStockQty) +
    kpiCard("kpiStockValue","Stock Value on Hand", totals.stockValue, {money:true}) +
    kpiCard("kpiSalesValue","Sales Value Till Date", totals.salesValue, {money:true}) +
    kpiCard("kpiReorder","Items to Reorder", totals.reorderCount, {warn: totals.reorderCount>0}) +
    kpiCard("kpiExpiry","Expiring Within 30 Days", expiryStats.soonQty, {warn: expiryStats.soonQty>0}) +
    kpiCard("kpiDamaged","Damaged Stock", totals.damagedQty,
      {warn: totals.damagedQty>0, sub: totals.damagedQty>0 ? `worth ${fmtMoney(totals.damagedValue)}` : ""}) +
    // Live count of stock still sitting in inventory past its expiry date — driven straight
    // off batch expiry dates, same as the "Expiring" card above, so it moves on its own as
    // dates pass instead of only when someone manually logs an "Expired write-off" adjustment.
    kpiCard("kpiExpired","Expired Stock (Not Yet Written Off)", expiryStats.overdueQty, {warn: expiryStats.overdueQty>0}) +
    kpiCard("kpiSamplesReceived","Samples Received", sampleStats.receivedTotal) +
    kpiCard("kpiSamplesSent","Samples Sent", sampleStats.sentTotal);
  animateCount(document.getElementById("kpiStockQty"), totals.totalStockQty);
  animateCount(document.getElementById("kpiStockValue"), totals.stockValue, {money:true});
  animateCount(document.getElementById("kpiSalesValue"), totals.salesValue, {money:true});
  animateCount(document.getElementById("kpiReorder"), totals.reorderCount);
  animateCount(document.getElementById("kpiExpiry"), expiryStats.soonQty);
  animateCount(document.getElementById("kpiSamplesReceived"), sampleStats.receivedTotal);
  animateCount(document.getElementById("kpiSamplesSent"), sampleStats.sentTotal);
  animateCount(document.getElementById("kpiDamaged"), totals.damagedQty);
  animateCount(document.getElementById("kpiExpired"), expiryStats.overdueQty);
}

function monthsWithSales(){
  const set = new Set();
  activity.filter(a=>a.type==="sale" && a.date).forEach(a=>set.add(a.date.slice(0,7)));
  return Array.from(set).sort().reverse();
}

function populateTopSellingMonths(){
  const sel = document.getElementById("topSellingMonth");
  const current = sel.value;
  const months = monthsWithSales();
  sel.innerHTML = '<option value="">All-time</option>' + months.map(m=>`<option value="${m}">${m}</option>`).join("");
  if(months.includes(current)) sel.value = current;
}

function renderTopSelling(){
  const sel = document.getElementById("topSellingMonth");
  const month = sel.value;
  document.getElementById("topSellingHint").textContent = month ? month : "all-time";
  let ranked;
  if(month){
    const byId = new Map();
    activity.filter(a=>a.type==="sale" && a.date && a.date.slice(0,7)===month).forEach(a=>{
      byId.set(a.productId, (byId.get(a.productId)||0) + a.qty);
    });
    ranked = Array.from(byId.entries()).map(([productId,qty])=>{
      const p = findProduct(productId);
      return { name: p ? p.name : "(deleted product)", qty };
    });
  } else {
    ranked = activeProducts().map(p=>({ name:p.name, qty:p.salesTotal||0 }));
  }
  ranked = ranked.filter(r=>r.qty>0).sort((a,b)=>b.qty-a.qty).slice(0,10);
  const max = ranked.length ? ranked[0].qty : 1;
  const wrap = document.getElementById("topSellingChart");
  if(!ranked.length){ wrap.innerHTML = '<p class="note" style="margin:0;">No sales recorded yet.</p>'; return; }
  wrap.innerHTML = ranked.map(r=>`
    <div class="bar-row">
      <span class="name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>
      <div class="bar-track"><div class="bar-fill" data-width="${(r.qty/max*100).toFixed(1)}"><span class="bar-tooltip">${fmtNum(r.qty)} units</span></div></div>
      <span class="bar-val mono">${fmtNum(r.qty)} units</span>
    </div>
  `).join("");
  requestAnimationFrame(()=>{
    wrap.querySelectorAll(".bar-fill").forEach(el=>{ el.style.width = el.dataset.width + "%"; });
  });
}

let reorderAlertsSort = { key:"stock", dir:1 };

function renderReorderAlerts(){
  const panel = document.getElementById("reorderAlertsPanel");
  const all = activeProducts().filter(p=>(p.stock||0) <= (p.reorderThreshold||0));
  if(!all.length){ panel.innerHTML = '<p class="note" style="margin:0;">Nothing needs reordering right now.</p>'; return; }

  all.sort((a,b)=>{
    const key = reorderAlertsSort.key;
    const av = key==="name" ? a.name : (a[key]||0);
    const bv = key==="name" ? b.name : (b[key]||0);
    const cmp = typeof av === "string" ? av.localeCompare(bv) : av - bv;
    return cmp * reorderAlertsSort.dir;
  });
  const rows = all.slice(0,8);
  const arrow = (key)=> reorderAlertsSort.key===key ? (reorderAlertsSort.dir===1 ? " ▲" : " ▼") : "";

  panel.innerHTML = `<table><thead><tr>
      <th data-key="name">Product${arrow("name")}</th>
      <th data-key="stock" class="right">Stock${arrow("stock")}</th>
      <th data-key="reorderThreshold" class="right">Reorder At${arrow("reorderThreshold")}</th>
      <th class="no-sort"></th>
    </tr></thead><tbody>` +
    rows.map(p=>`<tr><td class="name-cell">${escapeHtml(p.name)}</td><td class="right">${fmtNum(p.stock)}</td><td class="right">${fmtNum(p.reorderThreshold)}</td><td>${statusTag(itemStatus(p))}</td></tr>`).join("") +
    `</tbody></table>` +
    (all.length>8 ? `<p class="note" style="margin:8px 0 0;">Showing ${rows.length} of ${all.length} — click a column to re-sort, or see Reports → Items to Reorder for the full list.</p>` : "");

  panel.querySelectorAll("th[data-key]").forEach(th=>{
    th.addEventListener("click", ()=>{
      const key = th.dataset.key;
      if(reorderAlertsSort.key === key) reorderAlertsSort.dir *= -1; else { reorderAlertsSort.key = key; reorderAlertsSort.dir = 1; }
      renderReorderAlerts();
    });
  });
}

function renderExpiryAlerts(expiryStats){
  const panel = document.getElementById("expiryAlertsPanel");
  const all = expiryStats.rows; // already sorted soonest/most-overdue first
  if(!all.length){ panel.innerHTML = '<p class="note" style="margin:0;">Nothing expiring in the next 30 days.</p>'; return; }
  const rows = all.slice(0,10);
  panel.innerHTML = `<table><thead><tr><th>Product</th><th class="right">Qty</th><th>Expiry</th><th class="no-sort"></th></tr></thead><tbody>` +
    rows.map(r=>`<tr><td class="name-cell">${escapeHtml(r.productName)}</td><td class="right">${fmtNum(r.qty)}</td><td>${r.expiryDate}</td>
      <td>${r.status==="overdue" ? `<span class="tag overdue">${Math.abs(r.diffDays)}d overdue</span>` : `<span class="tag soon">${r.diffDays}d left</span>`}</td></tr>`).join("") +
    `</tbody></table>` +
    (all.length>10 ? `<p class="note" style="margin:8px 0 0;">Showing ${rows.length} of ${all.length} — see Reports → Expiry Dates for the full list.</p>` : "");
}

function renderSampleActivity(sampleStats){
  const hint = document.getElementById("sampleActivityHint");
  if(hint) hint.textContent = `${fmtNum(sampleStats.receivedTotal)} received · ${fmtNum(sampleStats.sentTotal)} sent`;
  const panel = document.getElementById("sampleActivityPanel");
  const all = sampleStats.rows; // already sorted by total sample activity, busiest first
  if(!all.length){ panel.innerHTML = '<p class="note" style="margin:0;">No sample activity recorded yet.</p>'; return; }
  const rows = all.slice(0,10);
  panel.innerHTML = `<table><thead><tr><th>Product</th><th class="right">Received</th><th class="right">Sent</th></tr></thead><tbody>` +
    rows.map(r=>`<tr><td class="name-cell">${escapeHtml(r.productName)}</td><td class="right">${fmtNum(r.received)}</td><td class="right">${fmtNum(r.sent)}</td></tr>`).join("") +
    `</tbody></table>` +
    (all.length>10 ? `<p class="note" style="margin:8px 0 0;">Showing ${rows.length} of ${all.length} products with sample activity.</p>` : "");
}

function renderTopCustomers(){
  const byParty = new Map();
  activity.filter(a=>a.type==="sale" && a.party).forEach(a=>{
    const cur = byParty.get(a.party) || { qty:0, value:0 };
    cur.qty += a.qty; cur.value += a.qty * (a.price||0);
    byParty.set(a.party, cur);
  });
  const ranked = Array.from(byParty.entries()).map(([name,v])=>({name, ...v})).sort((a,b)=>b.value-a.value).slice(0,6);
  const panel = document.getElementById("topCustomersPanel");
  if(!ranked.length){ panel.innerHTML = '<p class="note" style="margin:0;">No sales linked to a named client yet — record a sale with a client selected to see them here.</p>'; return; }
  const max = ranked[0].value || 1;
  panel.innerHTML = ranked.map(r=>`
    <div class="bar-row">
      <span class="name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>
      <div class="bar-track"><div class="bar-fill" data-width="${(r.value/max*100).toFixed(1)}"><span class="bar-tooltip">${fmtMoney(r.value)}</span></div></div>
      <span class="bar-val mono">${fmtMoney(r.value)}</span>
    </div>
  `).join("");
  requestAnimationFrame(()=>{
    panel.querySelectorAll(".bar-fill").forEach(el=>{ el.style.width = el.dataset.width + "%"; });
  });
}

function timeAgo(createdAt){
  if(!createdAt || !createdAt.toDate) return "just now";
  const d = createdAt.toDate();
  const diffSec = Math.round((Date.now() - d.getTime())/1000);
  if(diffSec < 60) return "just now";
  if(diffSec < 3600) return Math.floor(diffSec/60)+"m ago";
  if(diffSec < 86400) return Math.floor(diffSec/3600)+"h ago";
  return d.toLocaleDateString("en-IN", {day:"numeric", month:"short"}) + " " + d.toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"});
}

const REVERSIBLE_TYPES = ["sale","purchase","damage","expired","sample","sampleSent"];

// Friendly label for the activity feed — every other type already reads fine raw;
// only the two sample directions need spelling out so they're not shown as "sampleSent".
function activityTypeLabel(type){
  if(type === "sample") return "sample received";
  if(type === "sampleSent") return "sample sent";
  return type;
}

function renderActivityFeed(){
  const tbody = document.getElementById("activityFeedBody");
  const rows = activity.slice(0, 25);
  const canUndo = currentUser.role === "admin";
  if(!rows.length){ tbody.innerHTML = '<tr><td colspan="7" class="note" style="font-family:-apple-system,sans-serif;">No activity yet.</td></tr>'; return; }
  tbody.innerHTML = rows.map(a=>`
    <tr>
      <td class="mono">${timeAgo(a.createdAt)}</td>
      <td class="name-cell">${escapeHtml(a.actorName||"—")}</td>
      <td class="name-cell">${escapeHtml(activityTypeLabel(a.type))}</td>
      <td class="name-cell">${escapeHtml(a.productName||"(deleted)")}</td>
      <td class="right">${fmtNum(a.qty)}</td>
      <td class="name-cell">${escapeHtml(a.note||"")}</td>
      <td>${(canUndo && REVERSIBLE_TYPES.includes(a.type)) ? `<button class="btn small secondary undo-btn" data-id="${a.id}">Undo</button>` : ""}</td>
    </tr>
  `).join("");
  if(canUndo){
    tbody.querySelectorAll(".undo-btn").forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        const entry = activity.find(a=>a.id===btn.dataset.id);
        if(!entry) return;
        const ok = await showConfirm({
          title:"Undo this entry?",
          body:`This reverses the stock effect of this ${activityTypeLabel(entry.type)} of ${entry.qty} × "${entry.productName}" and removes it from the log. This cannot be undone.`,
          okLabel:"Undo entry"
        });
        if(!ok) return;
        try{ await undoActivityEntry(entry); toast("success","Entry undone."); }
        catch(err){ toast("error","Couldn't undo: "+err.message); }
      });
    });
  }
}

function renderDashboard(){
  if(!currentUser) return;
  const totals = computeTotals();
  const expiryStats = computeExpiryStats();
  const sampleStats = computeSampleStats();
  renderTape(totals);
  renderKPIs(totals, expiryStats, sampleStats);
  populateTopSellingMonths();
  renderTopSelling();
  renderReorderAlerts();
  renderExpiryAlerts(expiryStats);
  renderSampleActivity(sampleStats);
  renderTopCustomers();
  renderActivityFeed();
}

document.getElementById("topSellingMonth").addEventListener("change", renderTopSelling);

/* ============================== 7. PRODUCTS + ADD PRODUCT ============================== */

let productSort = { key:"name", dir:1 };
let modifyTargetId = null;

function canEditProducts(){ return currentUser.role === "admin" || currentUser.role === "manager"; }
function canDelete(){ return currentUser.role === "admin"; }

document.querySelectorAll("#productsTable th[data-key]").forEach(th=>{
  th.addEventListener("click", ()=>{
    const key = th.dataset.key;
    if(productSort.key === key) productSort.dir *= -1; else { productSort.key = key; productSort.dir = 1; }
    renderProductsTable();
  });
});
document.getElementById("productSearch").addEventListener("input", renderProductsTable);
document.querySelectorAll(".statusFilterCheck").forEach(cb=>cb.addEventListener("change", renderProductsTable));

function renderProductsTable(){
  const tbody = document.getElementById("productTbody");
  if(!tbody || !currentUser) return;
  const term = (document.getElementById("productSearch").value||"").trim().toLowerCase();
  const activeStatuses = Array.from(document.querySelectorAll(".statusFilterCheck")).filter(c=>c.checked).map(c=>c.value);

  let rows = activeProducts().filter(p=>{
    if(term && !(p.name.toLowerCase().includes(term) || (p.pack||"").toLowerCase().includes(term))) return false;
    if(!activeStatuses.includes(itemStatus(p))) return false;
    return true;
  });
  rows.sort((a,b)=>{
    const av = a[productSort.key], bv = b[productSort.key];
    if(typeof av === "string") return av.localeCompare(bv) * productSort.dir;
    return ((av||0) - (bv||0)) * productSort.dir;
  });

  const editable = canEditProducts();
  const delOk = canDelete();

  tbody.innerHTML = rows.map(p=>{
    const status = itemStatus(p);
    const rowClass = status==="out" ? "zero-stock" : status==="low" ? "low-stock" : "";
    return `<tr class="${rowClass}" data-id="${p.id}">
      <td class="name-cell">${escapeHtml(p.name)}</td>
      <td class="name-cell">${escapeHtml(p.pack||"")}</td>
      <td class="right">${fmtNum(p.stock)}</td>
      <td class="right">${fmtNum(p.purchaseTotal)}</td>
      <td class="right">${fmtNum(p.salesTotal)}</td>
      <td class="right">${editable ? `<input type="number" class="edit-cell field-cost" min="0" step="0.01" value="${p.cost}">` : fmtMoney(p.cost)}</td>
      <td class="right">${editable ? `<input type="number" class="edit-cell field-price" min="0" step="0.01" value="${p.price}">` : fmtMoney(p.price)}</td>
      <td class="right">${editable ? `<input type="number" class="edit-cell field-threshold" min="0" step="1" value="${p.reorderThreshold}">` : fmtNum(p.reorderThreshold)}</td>
      <td>${statusTag(status)}</td>
      <td style="white-space:nowrap;">
        ${editable ? `<button class="btn small secondary modify-btn" data-id="${p.id}">Modify</button>` : ""}
        ${delOk ? `<button class="btn small danger del-btn" data-id="${p.id}" style="margin-left:6px;">Delete</button>` : ""}
      </td>
    </tr>`;
  }).join("");

  if(editable){
    const FIELD_LABELS = { cost:"Cost", price:"Price", reorderThreshold:"Reorder threshold" };
    tbody.querySelectorAll(".field-cost, .field-price, .field-threshold").forEach(input=>{
      input.addEventListener("change", async (e)=>{
        const tr = e.target.closest("tr");
        const id = tr.dataset.id;
        const field = e.target.classList.contains("field-cost") ? "cost" : e.target.classList.contains("field-price") ? "price" : "reorderThreshold";
        const val = Number(e.target.value);
        if(isNaN(val) || val < 0){ toast("error","Enter a valid non-negative number."); renderProductsTable(); return; }
        const p = findProduct(id);
        const oldVal = p ? p[field] : null;
        try{
          const fields = { updatedAt: serverTimestamp(), updatedBy: currentUser.uid };
          fields[field] = val;
          if(field === "cost"){
            fields.maxCost = Math.max(p.maxCost||0, val);
          }
          await updateDoc(doc(db,"products",id), fields);
          await addDoc(collection(db,"activity"), {
            type:"modified", productId:id, productName: p ? p.name : "", qty:0,
            note:`${FIELD_LABELS[field]} changed from ${oldVal} to ${val}`,
            ...actorFields(), createdAt: serverTimestamp()
          });
          toast("success","Saved.");
        }catch(err){ toast("error","Couldn't save: "+err.message); }
      });
    });
    tbody.querySelectorAll(".modify-btn").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const p = findProduct(btn.dataset.id);
        if(!p) return;
        modifyTargetId = p.id;
        document.getElementById("modifyProductName").textContent = p.name;
        document.getElementById("modifyPurchase").value = p.purchaseTotal||0;
        document.getElementById("modifySales").value = p.salesTotal||0;
        openModal("modifyProductModal");
      });
    });
  }
  if(delOk){
    tbody.querySelectorAll(".del-btn").forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        const p = findProduct(btn.dataset.id);
        if(!p) return;
        const ok = await showConfirm({
          title:"Delete this product?",
          body:`"${p.name}" will be removed from every list. Its past activity history is kept for your records.`,
          okLabel:"Delete product"
        });
        if(!ok) return;
        try{
          await updateDoc(doc(db,"products",p.id), { archived:true, updatedAt: serverTimestamp(), updatedBy: currentUser.uid });
          toast("success","Product deleted.");
        }catch(err){ toast("error","Couldn't delete: "+err.message); }
      });
    });
  }
}

document.getElementById("modifyProductCancel").addEventListener("click", ()=>closeModal("modifyProductModal"));
document.getElementById("modifyProductSave").addEventListener("click", async ()=>{
  const p = findProduct(modifyTargetId);
  if(!p) return;
  const purchaseTotal = Number(document.getElementById("modifyPurchase").value);
  const salesTotal = Number(document.getElementById("modifySales").value);
  if(isNaN(purchaseTotal) || isNaN(salesTotal) || purchaseTotal<0 || salesTotal<0){
    toast("error","Enter valid non-negative numbers."); return;
  }
  const newStock = purchaseTotal - salesTotal - (p.damageTotal||0) - (p.expiredTotal||0) - (p.sampleSentTotal||0) + (p.sampleTotal||0);
  try{
    await updateDoc(doc(db,"products",p.id), {
      purchaseTotal, salesTotal, stock:newStock, updatedAt: serverTimestamp(), updatedBy: currentUser.uid
    });
    await addDoc(collection(db,"activity"), {
      type:"modified", productId:p.id, productName:p.name, qty:0,
      note:`Corrected totals — purchased ${p.purchaseTotal||0}→${purchaseTotal}, sold ${p.salesTotal||0}→${salesTotal}`,
      ...actorFields(), createdAt: serverTimestamp()
    });
    toast("success", newStock<0 ? "Saved — note stock is now negative." : "Totals corrected.");
    closeModal("modifyProductModal");
  }catch(err){ toast("error","Couldn't save: "+err.message); }
});

document.getElementById("addProductForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const name = document.getElementById("npName").value.trim();
  const pack = document.getElementById("npPack").value.trim();
  const cost = Number(document.getElementById("npCost").value);
  const price = Number(document.getElementById("npPrice").value);
  const gst = Number(document.getElementById("npGst").value) || 0;
  const reorderThreshold = Number(document.getElementById("npThreshold").value) || 0;
  const initialStock = Number(document.getElementById("npStock").value) || 0;
  const expiryDate = document.getElementById("npExpiry").value;
  const flash = document.getElementById("addProductFlash");
  flash.className = "flash";
  if(!name){ flash.className="flash show error"; flash.textContent="Product name is required."; return; }
  if(activeProducts().some(p=>p.name.toLowerCase()===name.toLowerCase())){
    flash.className="flash show error"; flash.textContent="A product with this name already exists."; return;
  }
  if(isNaN(cost) || cost<0 || isNaN(price) || price<0){
    flash.className="flash show error"; flash.textContent="Cost and price must be valid non-negative numbers."; return;
  }
  if(initialStock>0 && !expiryDate){
    flash.className="flash show error"; flash.textContent="Enter an expiry date for the initial stock — it can't be added later."; return;
  }
  if(initialStock===0 && expiryDate){
    // Guards against a confusing silent no-op: with 0 stock there's no batch to attach the
    // date to, so it would otherwise be entered and quietly dropped — the product would then
    // never show up in Expiry Dates or the dashboard's expiry KPIs despite looking "set up".
    flash.className="flash show error";
    flash.textContent="You entered an expiry date but no initial stock — an expiry date only sticks if there's a quantity to attach it to. Enter a stock quantity, or clear the expiry date.";
    return;
  }
  try{
    const productRef = await addDoc(collection(db,"products"), {
      name, pack, cost, price, gst, reorderThreshold,
      stock: initialStock, purchaseTotal: initialStock, salesTotal:0, damageTotal:0, expiredTotal:0, sampleTotal:0, sampleSentTotal:0,
      maxCost:cost, batches: initialStock>0 ? [{ qty:initialStock, expiryDate, purchaseDate: todayISO() }] : [],
      archived:false,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: currentUser.uid
    });
    await addDoc(collection(db,"activity"), {
      type:"added", productId:productRef.id, productName:name, qty:initialStock,
      note:`Added — cost ${fmtMoney(cost)}, price ${fmtMoney(price)}${initialStock>0 ? `, expiry ${expiryDate}` : ""}`,
      ...actorFields(), createdAt: serverTimestamp()
    });
    flash.className="flash show success"; flash.textContent=`"${name}" added.`;
    e.target.reset();
    document.getElementById("npGst").value = 5;
    document.getElementById("npThreshold").value = 50;
    toast("success","Product added.");
  }catch(err){
    flash.className="flash show error"; flash.textContent="Couldn't add product: "+err.message;
  }
});

/* ============================== 8. RECORD SALE / PURCHASE / ADJUSTMENTS ============================== */

function refreshProductSelects(){
  const options = activeProducts().map(p=>`<option value="${p.id}">${escapeHtml(p.name)} (${fmtNum(p.stock)} in stock)</option>`).join("");
  ["saleProduct","purchaseProduct","adjustProduct"].forEach(id=>{
    const sel = document.getElementById(id);
    const prev = sel.value;
    sel.innerHTML = '<option value="">Select a product…</option>' + options;
    if(Array.from(sel.options).some(o=>o.value===prev)) sel.value = prev;
  });
}

function refreshPartyDatalists(){
  document.getElementById("clientsList").innerHTML = activeClients().map(c=>`<option value="${escapeHtml(c.name)}">`).join("");
  document.getElementById("suppliersList").innerHTML = activeSuppliers().map(s=>`<option value="${escapeHtml(s.name)}">`).join("");
}

/* ---- Record Sale ---- */
const saleProductSel = document.getElementById("saleProduct");
saleProductSel.addEventListener("change", ()=>{
  const p = findProduct(saleProductSel.value);
  if(p) document.getElementById("salePrice").value = p.price;
  updateSalePreview();
});
["saleQty","salePrice"].forEach(id=>document.getElementById(id).addEventListener("input", updateSalePreview));
function updateSalePreview(){
  const box = document.getElementById("salePreview");
  const p = findProduct(saleProductSel.value);
  const qty = Number(document.getElementById("saleQty").value);
  const price = Number(document.getElementById("salePrice").value);
  if(!p || !qty){ box.classList.add("hidden"); return; }
  const resultingStock = (p.stock||0) - qty;
  box.classList.remove("hidden");
  box.innerHTML = `Total: <strong>${fmtMoney(qty*price)}</strong> &nbsp;·&nbsp; Resulting stock: <strong style="${resultingStock<0?"color:var(--danger)":""}">${fmtNum(resultingStock)}</strong>` +
    (resultingStock<0 ? " — this will go negative." : "");
}
document.getElementById("saleForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const flash = document.getElementById("saleFlash");
  const productId = saleProductSel.value;
  const qty = Number(document.getElementById("saleQty").value);
  const price = Number(document.getElementById("salePrice").value);
  const party = document.getElementById("saleParty").value.trim();
  const date = document.getElementById("saleDate").value;
  const note = document.getElementById("saleNote").value.trim();
  if(!productId || !qty || qty<=0 || isNaN(price) || price<0 || !date){
    flash.className="flash show error"; flash.textContent="Please fill in product, a positive quantity, price, and date."; return;
  }
  if(!party){
    flash.className="flash show error"; flash.textContent="Client is required — every sale must be linked to a client."; return;
  }
  try{
    await recordSale({productId, qty, price, party, date, note});
    flash.className="flash show success"; flash.textContent="Sale recorded.";
    toast("success","Sale recorded.");
    e.target.reset();
    document.getElementById("saleDate").value = todayISO();
    document.getElementById("salePreview").classList.add("hidden");
  }catch(err){ flash.className="flash show error"; flash.textContent="Couldn't record sale: "+err.message; }
});

/* ---- Record Purchase ---- */
const purchaseProductSel = document.getElementById("purchaseProduct");
purchaseProductSel.addEventListener("change", ()=>{
  const p = findProduct(purchaseProductSel.value);
  if(p) document.getElementById("purchasePrice").value = p.cost;
  updatePurchasePreview();
});
["purchaseQty","purchasePrice"].forEach(id=>document.getElementById(id).addEventListener("input", updatePurchasePreview));
function updatePurchasePreview(){
  const box = document.getElementById("purchasePreview");
  const p = findProduct(purchaseProductSel.value);
  const qty = Number(document.getElementById("purchaseQty").value);
  const price = Number(document.getElementById("purchasePrice").value);
  if(!p || !qty){ box.classList.add("hidden"); return; }
  const resultingStock = (p.stock||0) + qty;
  const isNewMax = price > (p.maxCost||p.cost||0);
  box.classList.remove("hidden");
  box.innerHTML = `Total: <strong>${fmtMoney(qty*price)}</strong> &nbsp;·&nbsp; Resulting stock: <strong>${fmtNum(resultingStock)}</strong>` +
    (isNewMax ? ` <span class="tag bumped">new highest cost</span>` : "");
}
document.getElementById("purchaseForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const flash = document.getElementById("purchaseFlash");
  const productId = purchaseProductSel.value;
  const qty = Number(document.getElementById("purchaseQty").value);
  const price = Number(document.getElementById("purchasePrice").value);
  const vendor = document.getElementById("purchaseVendor").value.trim();
  const date = document.getElementById("purchaseDate").value;
  const expiryDate = document.getElementById("purchaseExpiry").value;
  const note = document.getElementById("purchaseNote").value.trim();
  if(!productId || !qty || qty<=0 || isNaN(price) || price<0 || !date){
    flash.className="flash show error"; flash.textContent="Please fill in product, a positive quantity, price, and date."; return;
  }
  if(!expiryDate){
    flash.className="flash show error"; flash.textContent="Expiry date is required — it can't be added or changed after this purchase is saved."; return;
  }
  if(!vendor){
    flash.className="flash show error"; flash.textContent="Supplier is required — every purchase must be linked to a supplier."; return;
  }
  try{
    await recordPurchase({productId, qty, price, vendor, date, expiryDate, note});
    flash.className="flash show success"; flash.textContent="Purchase recorded.";
    toast("success","Purchase recorded.");
    e.target.reset();
    document.getElementById("purchaseDate").value = todayISO();
    document.getElementById("purchasePreview").classList.add("hidden");
  }catch(err){ flash.className="flash show error"; flash.textContent="Couldn't record purchase: "+err.message; }
});

/* ---- Adjustments ---- */
const adjustProductSel = document.getElementById("adjustProduct");
const adjustTypeSel = document.getElementById("adjustType");
[adjustProductSel, adjustTypeSel, document.getElementById("adjustQty")].forEach(el=>el.addEventListener("input", updateAdjustPreview));
function updateAdjustPreview(){
  const box = document.getElementById("adjustPreview");
  const p = findProduct(adjustProductSel.value);
  const qty = Number(document.getElementById("adjustQty").value);
  const type = adjustTypeSel.value;
  if(!p || !qty){ box.classList.add("hidden"); return; }
  const resultingStock = type==="sample" ? (p.stock||0)+qty : (p.stock||0)-qty;
  box.classList.remove("hidden");
  let extra = "";
  if(type === "expired"){
    const overdueQty = (p.batches||[]).filter(b=>diffDaysFromToday(b.expiryDate)<0).reduce((s,b)=>s+b.qty,0);
    if(overdueQty>0) extra = ` &nbsp;·&nbsp; Already-overdue batch qty: <strong>${fmtNum(overdueQty)}</strong>`;
  }
  box.innerHTML = `Resulting stock: <strong style="${resultingStock<0?"color:var(--danger)":""}">${fmtNum(resultingStock)}</strong>${extra}`;
}
document.getElementById("adjustForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const flash = document.getElementById("adjustFlash");
  const adjType = adjustTypeSel.value;
  const productId = adjustProductSel.value;
  const qty = Number(document.getElementById("adjustQty").value);
  const date = document.getElementById("adjustDate").value;
  const note = document.getElementById("adjustNote").value.trim();
  if(!productId || !qty || qty<=0 || !date){
    flash.className="flash show error"; flash.textContent="Please fill in product, a positive quantity, and date."; return;
  }
  try{
    await recordAdjustment({adjType, productId, qty, date, note});
    flash.className="flash show success"; flash.textContent="Adjustment saved.";
    toast("success","Adjustment saved.");
    e.target.reset();
    document.getElementById("adjustDate").value = todayISO();
    document.getElementById("adjustPreview").classList.add("hidden");
  }catch(err){ flash.className="flash show error"; flash.textContent="Couldn't save adjustment: "+err.message; }
});

/* ============================== 9. UPDATE EXPIRY DATES (its own distinct screen) ============================== */

document.getElementById("expirySearch").addEventListener("input", renderExpiryView);

function expiryRows(){
  const term = (document.getElementById("expirySearch").value||"").trim().toLowerCase();
  const rows = [];
  for(const p of activeProducts()){
    (p.batches||[]).forEach((b, idx)=>{
      if(!b.qty || b.qty<=0) return;
      if(term && !p.name.toLowerCase().includes(term)) return;
      rows.push({ productId:p.id, batchIndex:idx, productName:p.name, pack:p.pack, qty:b.qty, expiryDate:b.expiryDate||PLACEHOLDER_DATE });
    });
  }
  rows.sort((a,b)=>a.productName.localeCompare(b.productName));
  return rows;
}

function renderExpiryView(){
  const tbody = document.getElementById("expiryTbody");
  if(!tbody || !currentUser) return;
  const rows = expiryRows();
  const total = rows.length;
  const done = rows.filter(r=>r.expiryDate !== PLACEHOLDER_DATE).length;
  document.getElementById("expiryProgressLabel").textContent = `${done} of ${total} batches have a specific expiry date on record`;
  document.getElementById("expiryProgressFill").style.width = total ? (done/total*100)+"%" : "0%";

  if(!rows.length){ tbody.innerHTML = '<tr><td colspan="4" class="note" style="font-family:-apple-system,sans-serif;">No stocked batches yet — expiry dates are set when a product is added or a purchase is recorded.</td></tr>'; return; }

  // Read-only by design: expiry dates are only ever set once, at the point a product is
  // added or a purchase is recorded — there is deliberately no edit control here.
  tbody.innerHTML = rows.map(r=>`
    <tr class="${r.expiryDate!==PLACEHOLDER_DATE ? "expiry-done" : ""}">
      <td class="name-cell">${escapeHtml(r.productName)}</td>
      <td class="name-cell">${escapeHtml(r.pack||"")}</td>
      <td class="right">${fmtNum(r.qty)}</td>
      <td class="mono">${r.expiryDate}</td>
    </tr>
  `).join("");
}

/* ============================== 10. CLIENTS & SUPPLIERS ============================== */

let renameTarget = null; // { kind:'clients'|'suppliers', id, oldName }

function partyRow(kind, p){
  const canManage = currentUser.role === "admin" || currentUser.role === "manager";
  const canArchive = currentUser.role === "admin";
  return `<tr data-id="${p.id}">
    <td class="name-cell">${escapeHtml(p.name)}</td>
    <td style="white-space:nowrap;">
      ${canManage ? `<button class="btn small secondary rename-btn" data-kind="${kind}" data-id="${p.id}">Rename</button>` : ""}
      ${canArchive ? `<button class="btn small danger archive-btn" data-kind="${kind}" data-id="${p.id}" style="margin-left:6px;">Remove</button>` : ""}
    </td>
  </tr>`;
}

function renderClientsSuppliers(){
  const clientsTbody = document.getElementById("clientsTbody");
  const suppliersTbody = document.getElementById("suppliersTbody");
  if(!clientsTbody || !currentUser) return;
  clientsTbody.innerHTML = activeClients().map(c=>partyRow("clients", c)).join("") || '<tr><td colspan="2" class="note" style="font-family:-apple-system,sans-serif;">No clients yet.</td></tr>';
  suppliersTbody.innerHTML = activeSuppliers().map(s=>partyRow("suppliers", s)).join("") || '<tr><td colspan="2" class="note" style="font-family:-apple-system,sans-serif;">No suppliers yet.</td></tr>';

  document.querySelectorAll(".rename-btn").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const kind = btn.dataset.kind;
      const list = kind==="clients" ? clients : suppliers;
      const p = list.find(x=>x.id===btn.dataset.id);
      if(!p) return;
      renameTarget = { kind, id:p.id, oldName:p.name };
      document.getElementById("renamePartyTitle").textContent = "Rename " + (kind==="clients"?"Client":"Supplier");
      document.getElementById("renamePartyInput").value = p.name;
      openModal("renamePartyModal");
    });
  });
  document.querySelectorAll(".archive-btn").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const kind = btn.dataset.kind;
      const list = kind==="clients" ? clients : suppliers;
      const p = list.find(x=>x.id===btn.dataset.id);
      if(!p) return;
      const ok = await showConfirm({
        title:"Remove this " + (kind==="clients"?"client":"supplier") + "?",
        body:`"${p.name}" will no longer appear in the picker lists. Past activity entries keep this name.`,
        okLabel:"Remove"
      });
      if(!ok) return;
      try{ await updateDoc(doc(db,kind,p.id), { active:false }); toast("success","Removed."); }
      catch(err){ toast("error","Couldn't remove: "+err.message); }
    });
  });
}

document.getElementById("clientForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const input = document.getElementById("newClientName");
  const name = input.value.trim();
  if(!name) return;
  if(activeClients().some(c=>c.name.toLowerCase()===name.toLowerCase())){ toast("error","That client already exists."); return; }
  try{ await addDoc(collection(db,"clients"), {name, active:true, createdAt: serverTimestamp()}); input.value=""; toast("success","Client added."); }
  catch(err){ toast("error","Couldn't add client: "+err.message); }
});
document.getElementById("supplierForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const input = document.getElementById("newSupplierName");
  const name = input.value.trim();
  if(!name) return;
  if(activeSuppliers().some(s=>s.name.toLowerCase()===name.toLowerCase())){ toast("error","That supplier already exists."); return; }
  try{ await addDoc(collection(db,"suppliers"), {name, active:true, createdAt: serverTimestamp()}); input.value=""; toast("success","Supplier added."); }
  catch(err){ toast("error","Couldn't add supplier: "+err.message); }
});

document.getElementById("renamePartyCancel").addEventListener("click", ()=>closeModal("renamePartyModal"));
document.getElementById("renamePartySave").addEventListener("click", async ()=>{
  if(!renameTarget) return;
  const newName = document.getElementById("renamePartyInput").value.trim();
  if(!newName){ toast("error","Name can't be empty."); return; }
  const { kind, id, oldName } = renameTarget;
  if(newName === oldName){ closeModal("renamePartyModal"); return; }
  const list = kind==="clients" ? clients : suppliers;
  if(list.some(x=>x.id!==id && x.name.toLowerCase()===newName.toLowerCase())){
    toast("error","Another entry already has that name."); return;
  }
  try{
    await updateDoc(doc(db,kind,id), { name:newName });
    const field = kind==="clients" ? "party" : "vendor";
    const matches = activity.filter(a=>a[field] === oldName);
    if(matches.length){
      const batch = writeBatch(db);
      matches.forEach(a=>batch.update(doc(db,"activity",a.id), { [field]: newName }));
      await batch.commit();
    }
    toast("success","Renamed — historical entries updated too.");
    closeModal("renamePartyModal");
  }catch(err){ toast("error","Couldn't rename: "+err.message); }
});

/* ============================== 11. REPORTS ============================== */

function reportStockValue(){
  const rows = activeProducts().map(p=>{
    const cost = p.maxCost || p.cost || 0;
    const value = (p.stock||0) * cost;
    const damagedQty = p.damageTotal||0;
    const sampleQty = p.sampleTotal||0;
    const sampleSentQty = p.sampleSentTotal||0;
    return { csv:[p.name, p.pack||"", p.stock||0, cost, value, damagedQty, sampleQty, sampleSentQty],
      display:[escapeHtml(p.name), escapeHtml(p.pack||""), fmtNum(p.stock), fmtMoney(cost), fmtMoney(value), fmtNum(damagedQty), fmtNum(sampleQty), fmtNum(sampleSentQty)] };
  }).sort((a,b)=>b.csv[4]-a.csv[4]);
  return { headers:["Product","Pack","Stock","Cost (highest)","Value","Damaged Qty","Sample Received Qty","Sample Sent Qty"], rows };
}

function reportPriceList(){
  const rows = activeProducts().map(p=>{
    const margin = p.cost>0 ? ((p.price-p.cost)/p.cost*100) : 0;
    return { csv:[p.name, p.pack||"", p.cost, p.price, margin.toFixed(1)],
      display:[escapeHtml(p.name), escapeHtml(p.pack||""), fmtMoney(p.cost), fmtMoney(p.price), margin.toFixed(1)+"%"] };
  }).sort((a,b)=>a.csv[0].localeCompare(b.csv[0]));
  return { headers:["Product","Pack","Cost","Price","Margin %"], rows };
}

function reportReorder(){
  const rows = activeProducts().filter(p=>(p.stock||0) <= (p.reorderThreshold||0)).map(p=>{
    const shortfall = Math.max(0, (p.reorderThreshold||0) - (p.stock||0));
    return { csv:[p.name, p.pack||"", p.stock||0, p.reorderThreshold||0, shortfall],
      display:[escapeHtml(p.name), escapeHtml(p.pack||""), fmtNum(p.stock), fmtNum(p.reorderThreshold), fmtNum(shortfall)] };
  }).sort((a,b)=>a.csv[2]-b.csv[2]);
  return { headers:["Product","Pack","Stock","Reorder At","Shortfall"], rows };
}

function reportExpiry(){
  const stats = computeExpiryStats();
  const rows = stats.rows.map(r=>({
    csv:[r.productName, r.pack||"", r.qty, r.expiryDate, r.diffDays],
    display:[escapeHtml(r.productName), escapeHtml(r.pack||""), fmtNum(r.qty), r.expiryDate,
      r.status==="overdue" ? `${Math.abs(r.diffDays)}d overdue` : `${r.diffDays}d left`]
  }));
  return { headers:["Product","Pack","Qty","Expiry Date","Status"], rows };
}

function reportSales(){
  const byMonth = new Map();
  activity.filter(a=>a.type==="sale").forEach(a=>{
    const m = (a.date||"").slice(0,7);
    const cur = byMonth.get(m) || {qty:0, value:0};
    cur.qty += a.qty; cur.value += a.qty*(a.price||0);
    byMonth.set(m, cur);
  });
  const rows = Array.from(byMonth.entries()).sort((a,b)=>b[0].localeCompare(a[0])).map(([m,v])=>({
    csv:[m, v.qty, v.value], display:[m, fmtNum(v.qty), fmtMoney(v.value)]
  }));
  return { headers:["Month","Units Sold","Revenue"], rows };
}

function reportLedger(){
  const from = document.getElementById("ledgerFrom").value;
  const to = document.getElementById("ledgerTo").value;
  const clientFilter = document.getElementById("ledgerClient").value.trim().toLowerCase();
  const supplierFilter = document.getElementById("ledgerSupplier").value.trim().toLowerCase();
  let list = activity.filter(a=>a.type==="sale"||a.type==="purchase");
  if(from) list = list.filter(a=>(a.date||"") >= from);
  if(to) list = list.filter(a=>(a.date||"") <= to);
  if(clientFilter && !supplierFilter) list = list.filter(a=>a.type==="sale" && (a.party||"").toLowerCase().includes(clientFilter));
  else if(supplierFilter && !clientFilter) list = list.filter(a=>a.type==="purchase" && (a.vendor||"").toLowerCase().includes(supplierFilter));
  else if(clientFilter && supplierFilter) list = list.filter(a=>
    (a.type==="sale" && (a.party||"").toLowerCase().includes(clientFilter)) ||
    (a.type==="purchase" && (a.vendor||"").toLowerCase().includes(supplierFilter))
  );
  list = list.slice().sort((a,b)=>(a.date||"").localeCompare(b.date||""));
  const rows = list.map(a=>({
    csv:[a.date||"", a.type, a.productName, a.qty, a.price, a.type==="sale"?(a.party||""):(a.vendor||""), a.note||""],
    display:[a.date||"", a.type, escapeHtml(a.productName||""), fmtNum(a.qty), fmtMoney(a.price),
      escapeHtml(a.type==="sale"?(a.party||"—"):(a.vendor||"—")), escapeHtml(a.note||"")]
  }));
  return { headers:["Date","Type","Product","Qty","Price","Party","Note"], rows };
}

const REPORTS = { stockValue:reportStockValue, priceList:reportPriceList, sales:reportSales, reorder:reportReorder, expiry:reportExpiry, ledger:reportLedger };

function renderReportTable(container, headers, rows){
  if(!rows.length){ container.innerHTML = '<p class="note">No data to show.</p>'; return; }
  container.innerHTML = `<table><thead><tr>${headers.map(h=>`<th class="no-sort">${h}</th>`).join("")}</tr></thead><tbody>` +
    rows.map(r=>`<tr>${r.display.map((c,i)=>`<td class="${i===0?"name-cell":""}">${c}</td>`).join("")}</tr>`).join("") +
    `</tbody></table>`;
}

let salesDrilldownWired = false;
function renderSalesReport(){
  const container = document.getElementById("report-sales");
  const {headers, rows} = reportSales();
  const sel = document.getElementById("salesMonthDrilldown");
  const months = monthsWithSales();
  sel.style.display = months.length ? "inline-block" : "none";
  if(!salesDrilldownWired){ sel.addEventListener("change", renderSalesReport); salesDrilldownWired = true; }
  const current = sel.value;
  sel.innerHTML = '<option value="">Choose a month for product breakdown…</option>' + months.map(m=>`<option value="${m}">${m}</option>`).join("");
  if(months.includes(current)) sel.value = current;

  let html = "";
  if(!rows.length){ html = '<p class="note">No sales recorded yet.</p>'; }
  else {
    html = `<table><thead><tr>${headers.map(h=>`<th class="no-sort">${h}</th>`).join("")}</tr></thead><tbody>` +
      rows.map(r=>`<tr>${r.display.map((c,i)=>`<td class="${i===0?"name-cell":""}">${c}</td>`).join("")}</tr>`).join("") + `</tbody></table>`;
  }
  const chosenMonth = sel.value;
  if(chosenMonth){
    const byProduct = new Map();
    activity.filter(a=>a.type==="sale" && a.date && a.date.slice(0,7)===chosenMonth).forEach(a=>{
      const cur = byProduct.get(a.productId) || {name:a.productName, qty:0, value:0};
      cur.qty += a.qty; cur.value += a.qty*(a.price||0);
      byProduct.set(a.productId, cur);
    });
    const breakdown = Array.from(byProduct.values()).sort((a,b)=>b.qty-a.qty);
    html += `<h3 style="font-size:14px;margin:16px 0 8px;color:var(--olive-dark);font-family:Georgia,serif;">Breakdown for ${chosenMonth}</h3>`;
    html += breakdown.length ? `<table><thead><tr><th class="no-sort">Product</th><th class="no-sort right">Qty</th><th class="no-sort right">Revenue</th></tr></thead><tbody>` +
      breakdown.map(b=>`<tr><td class="name-cell">${escapeHtml(b.name)}</td><td class="right">${fmtNum(b.qty)}</td><td class="right">${fmtMoney(b.value)}</td></tr>`).join("") + `</tbody></table>` :
      '<p class="note">No sales in this month.</p>';
  }
  container.innerHTML = html;
}

function renderReport(key){
  if(key === "sales"){ renderSalesReport(); return; }
  const {headers, rows} = REPORTS[key]();
  renderReportTable(document.getElementById("report-"+key), headers, rows);
}

function downloadReportCsv(key){
  const {headers, rows} = REPORTS[key]();
  if(!rows.length){ toast("error","No data to export yet."); return; }
  const csv = toCsv(headers, rows.map(r=>r.csv));
  downloadText(`terra-foods-${key}-${todayISO()}.csv`, csv);
}

const reportShowing = {}; // key -> boolean, tracks whether each report's "View" is currently expanded

function toggleReport(key){
  const btn = document.querySelector(`[data-report="${key}"]`);
  if(reportShowing[key]){
    document.getElementById("report-"+key).innerHTML = "";
    if(key === "sales") document.getElementById("salesMonthDrilldown").style.display = "none";
    reportShowing[key] = false;
    if(btn) btn.textContent = "View";
  } else {
    renderReport(key);
    reportShowing[key] = true;
    if(btn) btn.textContent = "Hide";
  }
}

document.querySelectorAll("[data-report]").forEach(btn=>btn.addEventListener("click", ()=>toggleReport(btn.dataset.report)));
document.querySelectorAll("[data-report-csv]").forEach(btn=>btn.addEventListener("click", ()=>downloadReportCsv(btn.dataset.reportCsv)));

/* ============================== 12. USERS (role-scoped) ============================== */

function canManageUserRow(row){
  if(currentUser.role === "admin") return row.id !== currentUser.uid;
  if(currentUser.role === "manager") return row.role === "staff";
  return false;
}

function renderUsersTable(){
  const tbody = document.getElementById("usersTbody");
  if(!tbody || !currentUser) return;
  let rows = users;
  if(currentUser.role === "manager") rows = rows.filter(u=>u.role==="staff");
  if(!rows.length){ tbody.innerHTML = '<tr><td colspan="5" class="note" style="font-family:-apple-system,sans-serif;">No team members yet.</td></tr>'; return; }
  tbody.innerHTML = rows.map(u=>{
    const manageable = canManageUserRow(u);
    return `<tr data-id="${u.id}">
      <td class="name-cell">${escapeHtml(u.displayName||"—")}${u.id===currentUser.uid ? ' <span class="hint" style="font-size:11px;color:var(--ink-faint);">(you)</span>' : ""}</td>
      <td class="name-cell">${escapeHtml(u.email||"—")}</td>
      <td class="name-cell">${ROLE_LABELS[u.role]||u.role}</td>
      <td>${u.active===false ? '<span class="tag out">Inactive</span>' : '<span class="tag ok">Active</span>'}</td>
      <td style="white-space:nowrap;">
        ${manageable ? `<button class="btn small secondary toggle-active-btn" data-id="${u.id}">${u.active===false?"Reactivate":"Deactivate"}</button>
        <button class="btn small danger del-user-btn" data-id="${u.id}" style="margin-left:6px;">Delete</button>` : ""}
      </td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll(".toggle-active-btn").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const u = users.find(x=>x.id===btn.dataset.id);
      if(!u) return;
      try{
        await updateDoc(doc(db,"users",u.id), { active: u.active===false ? true : false });
        toast("success", u.active===false ? "Reactivated." : "Deactivated — they'll be signed out on their next action.");
      }catch(err){ toast("error","Couldn't update: "+err.message); }
    });
  });
  tbody.querySelectorAll(".del-user-btn").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const u = users.find(x=>x.id===btn.dataset.id);
      if(!u) return;
      const ok = await showConfirm({
        title:"Delete this account?",
        body:`"${u.displayName||u.email}" immediately loses all access to the portal. To fully remove their sign-in credential too, also delete them in Firebase Console → Authentication.`,
        okLabel:"Delete account"
      });
      if(!ok) return;
      try{ await deleteDoc(doc(db,"users",u.id)); toast("success","Account deleted."); }
      catch(err){ toast("error","Couldn't delete: "+err.message); }
    });
  });
}

document.getElementById("openAddUserBtn").addEventListener("click", ()=>{
  document.getElementById("userModalTitle").textContent = "Add Team Member";
  document.getElementById("userModalName").value = "";
  document.getElementById("userModalEmail").value = "";
  document.getElementById("userModalPassword").value = "";
  const roleSel = document.getElementById("userModalRole");
  const options = currentUser.role === "admin" ? ["admin","manager","staff","viewer"] : ["staff"];
  roleSel.innerHTML = options.map(r=>`<option value="${r}">${ROLE_LABELS[r]}</option>`).join("");
  openModal("userModal");
});
document.getElementById("userModalCancel").addEventListener("click", ()=>closeModal("userModal"));
document.getElementById("userModalSave").addEventListener("click", async ()=>{
  const name = document.getElementById("userModalName").value.trim();
  const email = document.getElementById("userModalEmail").value.trim();
  const password = document.getElementById("userModalPassword").value;
  const role = document.getElementById("userModalRole").value;
  if(!name || !email || password.length < 6){ toast("error","Fill in name, email, and a password of at least 6 characters."); return; }
  if(currentUser.role === "manager" && role !== "staff"){ toast("error","Managers can only create Staff accounts."); return; }
  const saveBtn = document.getElementById("userModalSave");
  saveBtn.disabled = true;
  const secondaryApp = initializeApp(firebaseConfig, "Secondary-" + Date.now());
  try{
    const secondaryAuth = getAuth(secondaryApp);
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    await setDoc(doc(db, "users", cred.user.uid), {
      email, displayName:name, role, active:true, createdBy: currentUser.uid, createdAt: serverTimestamp()
    });
    await signOut(secondaryAuth);
    toast("success", `Account created for ${name}. Share the email and temporary password with them directly.`);
    closeModal("userModal");
  }catch(err){
    toast("error", friendlyAuthError(err, "create that account"));
  }finally{
    saveBtn.disabled = false;
    await deleteApp(secondaryApp);
  }
});

/* ============================== 13. BACKUP & SETTINGS ============================== */

document.getElementById("exportProductsCsv").addEventListener("click", ()=>{
  const headers = ["Name","Pack","Stock","Cost","Price","GST %","Reorder Threshold","Purchased (total)","Sold (total)","Damaged","Expired","Sample Received","Sample Sent","Highest Cost"];
  const rows = activeProducts().map(p=>[p.name, p.pack||"", p.stock||0, p.cost||0, p.price||0, p.gst||0, p.reorderThreshold||0,
    p.purchaseTotal||0, p.salesTotal||0, p.damageTotal||0, p.expiredTotal||0, p.sampleTotal||0, p.sampleSentTotal||0, p.maxCost||p.cost||0]);
  downloadText(`terra-foods-products-${todayISO()}.csv`, toCsv(headers, rows));
});

document.getElementById("exportActivityCsv").addEventListener("click", ()=>{
  const headers = ["Date","Type","Product","Qty","Price","Party/Vendor","Note","Recorded By"];
  const rows = activity.slice().sort((a,b)=>(a.date||"").localeCompare(b.date||"")).map(a=>[
    a.date||"", a.type, a.productName||"", a.qty, a.price||"",
    a.type==="sale" ? (a.party||"") : a.type==="purchase" ? (a.vendor||"") : "",
    a.note||"", a.actorName||""
  ]);
  downloadText(`terra-foods-activity-${todayISO()}.csv`, toCsv(headers, rows));
});

document.getElementById("exportPartiesCsv").addEventListener("click", ()=>{
  const headers = ["Type","Name"];
  const rows = [...activeClients().map(c=>["Client", c.name]), ...activeSuppliers().map(s=>["Supplier", s.name])];
  downloadText(`terra-foods-clients-suppliers-${todayISO()}.csv`, toCsv(headers, rows));
});

let pendingImport = null; // { validRows:[{rowNum,name,pack,cost,price,gst,reorderThreshold}], invalidRows:[{rowNum,name,reason}] }

function resetImportUI(){
  pendingImport = null;
  document.getElementById("importPreview").classList.add("hidden");
  document.getElementById("importPreview").innerHTML = "";
  document.getElementById("confirmImportBtn").style.display = "none";
  document.getElementById("importProgressWrap").classList.add("hidden");
  document.getElementById("importErrorList").innerHTML = "";
  document.getElementById("importFlash").className = "flash";
}

document.getElementById("importProductsCsvInput").addEventListener("change", async (e)=>{
  const file = e.target.files[0];
  resetImportUI();
  if(!file) return;
  const flash = document.getElementById("importFlash");
  const text = await file.text();
  const rows = parseCsv(text).filter(r=>r.length && r.some(c=>c.trim()!==""));
  if(!rows.length){ flash.className="flash show error"; flash.textContent="That file looks empty."; e.target.value=""; return; }
  const header = rows[0].map(h=>h.trim().toLowerCase());
  const idx = {
    name: header.indexOf("name"), pack: header.indexOf("pack"), cost: header.indexOf("cost"),
    price: header.indexOf("price"), gst: header.indexOf("gst"), reorderThreshold: header.indexOf("reorderthreshold"),
    stock: header.indexOf("stock"), expiryDate: header.indexOf("expirydate")
  };
  if(idx.name === -1 || idx.cost === -1 || idx.price === -1){
    flash.className="flash show error"; flash.textContent="The CSV needs at least name, cost, and price columns."; e.target.value=""; return;
  }

  const validRows = [], invalidRows = [], stockWarnings = [], invalidDateRows = [];
  let stockCount = 0;
  rows.slice(1).forEach((r, i)=>{
    const rowNum = i + 2; // +1 to skip header, +1 for 1-indexed human-readable row numbers
    const name = (r[idx.name]||"").trim();
    const cost = Number(r[idx.cost]);
    const price = Number(r[idx.price]);
    if(!name || isNaN(cost) || isNaN(price)){
      invalidRows.push({ rowNum, name: name || "(blank)",
        reason: !name ? "missing product name" : isNaN(cost) ? "cost isn't a number" : "price isn't a number" });
      return;
    }
    // stock is optional per row — blank (or missing/unparseable) means "leave stock exactly as it is"
    let stock = null;
    if(idx.stock > -1){
      const raw = (r[idx.stock]||"").trim();
      if(raw !== ""){
        const parsed = Number(raw);
        if(!isNaN(parsed) && parsed >= 0) stock = parsed;
      }
    }
    const expiryDateRaw = idx.expiryDate>-1 ? (r[idx.expiryDate]||"").trim() : "";
    // Normalize to ISO (YYYY-MM-DD) on the way in — a CSV re-exported from Excel/Sheets often
    // reformats a date column to something like "3/31/2026", which looks fine sitting in
    // Firestore but silently never counts as "expiring soon" since the app's date math only
    // understands ISO. Anything unrecognized is treated the same as a missing date below.
    const expiryDate = expiryDateRaw ? normalizeExpiryDate(expiryDateRaw) : "";
    const dateUnrecognized = expiryDateRaw && !expiryDate;

    // Expiry date is mandatory whenever this row would actually create a NEW batch — i.e.
    // stock>0 and the matching product (new or existing) has no tracked batches yet. If the
    // matching product already has real batches, stock is just a number correction and no
    // new batch (so no expiry) is involved. Rather than reject the whole row over this,
    // only the stock/batch part is skipped — name/cost/price/etc. still get applied — and
    // it's called out clearly so it's never silently dropped.
    const existingProduct = activeProducts().find(p=>p.name.toLowerCase()===name.toLowerCase());
    const willCreateNewBatch = stock !== null && stock > 0 && !(existingProduct && existingProduct.batches && existingProduct.batches.length);
    if(willCreateNewBatch && !expiryDate){
      stockWarnings.push({ rowNum, name, reason: dateUnrecognized
        ? `has a stock quantity but its expiry date ("${expiryDateRaw}") isn't in a recognized format — stock left unchanged, other fields still applied`
        : "has a stock quantity but no expiry date — stock left unchanged, other fields still applied" });
      stock = null;
    } else if(stock !== null){
      stockCount++;
    } else if(dateUnrecognized){
      // Date given but not tied to a stock action on this row (blank/unchanged stock) — still
      // flag it rather than silently dropping what was typed.
      invalidDateRows.push({ rowNum, name, raw:expiryDateRaw });
    }

    validRows.push({
      rowNum, name,
      pack: idx.pack>-1 ? (r[idx.pack]||"").trim() : "",
      cost, price,
      gst: idx.gst>-1 && r[idx.gst]!=="" ? Number(r[idx.gst]) : 5,
      reorderThreshold: idx.reorderThreshold>-1 && r[idx.reorderThreshold]!=="" ? Number(r[idx.reorderThreshold]) : 50,
      stock, expiryDate
    });
  });

  pendingImport = { validRows, invalidRows };
  const preview = document.getElementById("importPreview");
  preview.classList.remove("hidden");
  let html = `<strong>${escapeHtml(file.name)}</strong>: ${validRows.length} product${validRows.length===1?"":"s"} ready to import`;
  if(idx.stock > -1) html += ` (${stockCount} with a stock value, ${validRows.length-stockCount} leaving stock unchanged)`;
  if(invalidRows.length) html += `, <span style="color:var(--danger)">${invalidRows.length} row${invalidRows.length===1?"":"s"} will be skipped</span>`;
  html += ".";
  if(invalidRows.length){
    html += `<ul style="margin:8px 0 0 18px; padding:0;">` +
      invalidRows.slice(0,10).map(r=>`<li>Row ${r.rowNum} (${escapeHtml(r.name)}): ${escapeHtml(r.reason)}</li>`).join("") +
      (invalidRows.length>10 ? `<li>…and ${invalidRows.length-10} more</li>` : "") + `</ul>`;
  }
  if(stockWarnings.length){
    html += `<p style="color:var(--mustard); margin:10px 0 0;">⚠ No usable expiry date for ${stockWarnings.length} row${stockWarnings.length===1?"":"s"}:</p>` +
      `<ul style="margin:4px 0 0 18px; padding:0;">` +
      stockWarnings.slice(0,10).map(r=>`<li>Row ${r.rowNum} (${escapeHtml(r.name)}): ${escapeHtml(r.reason)}</li>`).join("") +
      (stockWarnings.length>10 ? `<li>…and ${stockWarnings.length-10} more</li>` : "") + `</ul>`;
  }
  if(invalidDateRows.length){
    html += `<p style="color:var(--mustard); margin:10px 0 0;">⚠ Expiry date not in a recognized format for ${invalidDateRows.length} row${invalidDateRows.length===1?"":"s"} (ignored — no stock change was requested for these rows anyway):</p>` +
      `<ul style="margin:4px 0 0 18px; padding:0;">` +
      invalidDateRows.slice(0,10).map(r=>`<li>Row ${r.rowNum} (${escapeHtml(r.name)}): "${escapeHtml(r.raw)}"</li>`).join("") +
      (invalidDateRows.length>10 ? `<li>…and ${invalidDateRows.length-10} more</li>` : "") + `</ul>`;
  }
  preview.innerHTML = html;
  document.getElementById("confirmImportBtn").style.display = validRows.length ? "inline-flex" : "none";
});

document.getElementById("confirmImportBtn").addEventListener("click", async ()=>{
  if(!pendingImport || !pendingImport.validRows.length) return;
  const { validRows, invalidRows } = pendingImport;
  const confirmBtn = document.getElementById("confirmImportBtn");
  const fileInput = document.getElementById("importProductsCsvInput");
  const progressWrap = document.getElementById("importProgressWrap");
  const progressFill = document.getElementById("importProgressFill");
  const progressLabel = document.getElementById("importProgressLabel");
  const flash = document.getElementById("importFlash");
  const errorListEl = document.getElementById("importErrorList");

  confirmBtn.disabled = true;
  fileInput.disabled = true;
  progressWrap.classList.remove("hidden");
  errorListEl.innerHTML = "";
  flash.className = "flash";

  let added = 0, updated = 0;
  const failures = [];

  for(let i=0; i<validRows.length; i++){
    const row = validRows[i];
    progressFill.style.width = (i/validRows.length*100).toFixed(1) + "%";
    progressLabel.textContent = `Uploading ${i+1} of ${validRows.length} — ${row.name}`;
    try{
      const existing = activeProducts().find(p=>p.name.toLowerCase()===row.name.toLowerCase());
      if(existing){
        const fields = {
          pack:row.pack, cost:row.cost, price:row.price, gst:row.gst, reorderThreshold:row.reorderThreshold,
          maxCost: Math.max(existing.maxCost||0, row.cost),
          updatedAt: serverTimestamp(), updatedBy: currentUser.uid
        };
        // stock is only touched when the CSV row actually has a value — blank means "leave it alone"
        if(row.stock !== null){
          const needsNewBatch = !(existing.batches && existing.batches.length);
          if(needsNewBatch && row.stock > 0 && !row.expiryDate){
            // Data changed since the preview (e.g. this product's batches were cleared in
            // the meantime) — refuse rather than silently write an undated batch.
            throw new Error("stock given but no expiry date, and this would create a new batch");
          }
          fields.stock = row.stock;
          // if this product has no tracked batches yet, seed one so the new stock is
          // immediately assignable an expiry date; if it already has real batches, leave
          // them untouched rather than risk clobbering genuine per-lot expiry data.
          if(needsNewBatch){
            fields.batches = row.stock > 0 ? [{ qty: row.stock, expiryDate: row.expiryDate, purchaseDate: null }] : [];
          }
        }
        await updateDoc(doc(db,"products",existing.id), fields);
        updated++;
      } else {
        const initialStock = row.stock !== null ? row.stock : 0;
        if(initialStock > 0 && !row.expiryDate){
          throw new Error("stock given but no expiry date, and this would create a new batch");
        }
        await addDoc(collection(db,"products"), {
          name:row.name, pack:row.pack, cost:row.cost, price:row.price, gst:row.gst, reorderThreshold:row.reorderThreshold,
          stock:initialStock, purchaseTotal:initialStock, salesTotal:0, damageTotal:0, expiredTotal:0, sampleTotal:0, sampleSentTotal:0,
          maxCost:row.cost, batches: initialStock>0 ? [{ qty:initialStock, expiryDate: row.expiryDate, purchaseDate:null }] : [], archived:false,
          createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: currentUser.uid
        });
        added++;
      }
    }catch(err){
      failures.push({ rowNum: row.rowNum, name: row.name, reason: err.message || "unknown error" });
    }
  }
  progressFill.style.width = "100%";
  progressLabel.textContent = `Done — ${validRows.length} of ${validRows.length} processed.`;

  // One aggregate log entry for the whole import, rather than one per row — a bulk import
  // is one event from a "what happened" point of view, and per-row entries would flood the
  // activity feed and bury day-to-day sale/purchase entries under a single CSV upload.
  if(added>0 || updated>0){
    await addDoc(collection(db,"activity"), {
      type:"import", productId:"", productName:"CSV import", qty: added+updated,
      note:`Products CSV: ${added} added, ${updated} updated${failures.length ? `, ${failures.length} failed` : ""}`,
      ...actorFields(), createdAt: serverTimestamp()
    });
  }

  flash.className = "flash show success";
  flash.textContent = `Import complete: ${added} added, ${updated} updated` +
    (invalidRows.length ? `, ${invalidRows.length} skipped before upload (invalid data)` : "") +
    (failures.length ? `, ${failures.length} failed during upload` : "") + ".";

  if(failures.length){
    errorListEl.innerHTML = `<p class="note" style="color:var(--danger); margin:10px 0 4px;">These rows failed while uploading:</p>` +
      `<ul style="margin:0 0 0 18px; padding:0; font-size:12.5px; color:var(--ink-soft);">` +
      failures.map(f=>`<li>Row ${f.rowNum} (${escapeHtml(f.name)}): ${escapeHtml(f.reason)}</li>`).join("") + `</ul>`;
  }
  toast(failures.length ? "error" : "success", failures.length ? `Import finished with ${failures.length} error(s) — see details below.` : "CSV import complete.");

  confirmBtn.disabled = false;
  fileInput.disabled = false;
  fileInput.value = "";
  document.getElementById("confirmImportBtn").style.display = "none";
  document.getElementById("importPreview").classList.add("hidden");
  pendingImport = null;
  setTimeout(()=>{ progressWrap.classList.add("hidden"); }, 1500);
});

// One-time cleanup for batches that were written before dates were normalized on the way in
// (e.g. a CSV re-exported from Excel/Sheets with "3/31/2026" instead of "2026-03-31") — those
// sit in Firestore looking harmless but never register as "expiring soon" since the app's date
// math only understands ISO. Scans every product (active or archived) and rewrites any batch
// whose expiryDate isn't already YYYY-MM-DD. Safe to re-run — already-correct dates are skipped.
document.getElementById("fixExpiryFormatsBtn").addEventListener("click", async ()=>{
  const btn = document.getElementById("fixExpiryFormatsBtn");
  const flash = document.getElementById("fixExpiryFlash");
  const results = document.getElementById("fixExpiryResults");
  flash.className = "flash"; results.innerHTML = "";
  btn.disabled = true;
  try{
    const fixes = [], unresolved = [], updates = [];
    for(const p of products){
      let changed = false;
      const newBatches = (p.batches||[]).map(b=>{
        if(!b.expiryDate || /^\d{4}-\d{2}-\d{2}$/.test(b.expiryDate)) return b; // blank or already ISO
        const iso = normalizeExpiryDate(b.expiryDate);
        if(iso){
          changed = true;
          fixes.push({ productName:p.name, from:b.expiryDate, to:iso });
          return { ...b, expiryDate: iso };
        }
        unresolved.push({ productName:p.name, raw:b.expiryDate });
        return b;
      });
      if(changed) updates.push({ id:p.id, batches:newBatches });
    }
    if(!updates.length && !unresolved.length){
      flash.className="flash show success";
      flash.textContent="Nothing to fix — every tracked batch is already in YYYY-MM-DD format.";
      return;
    }
    // Firestore batched writes cap at 500 ops — chunk defensively even though this app's
    // catalog is nowhere near that size.
    for(let i=0; i<updates.length; i+=450){
      const batch = writeBatch(db);
      updates.slice(i,i+450).forEach(u=>batch.update(doc(db,"products",u.id),
        { batches:u.batches, updatedAt: serverTimestamp(), updatedBy: currentUser.uid }));
      await batch.commit();
    }
    let html = `<p style="margin:0 0 6px;">Fixed ${fixes.length} batch date${fixes.length===1?"":"s"} across ${updates.length} product${updates.length===1?"":"s"}.</p>`;
    if(fixes.length){
      html += `<ul style="margin:0 0 10px 18px; padding:0;">` +
        fixes.slice(0,15).map(f=>`<li>${escapeHtml(f.productName)}: "${escapeHtml(f.from)}" → ${f.to}</li>`).join("") +
        (fixes.length>15 ? `<li>…and ${fixes.length-15} more</li>` : "") + `</ul>`;
    }
    if(unresolved.length){
      html += `<p style="color:var(--danger); margin:6px 0 0;">⚠ Couldn't recognize ${unresolved.length} date${unresolved.length===1?"":"s"} — left as-is, needs a manual look:</p>` +
        `<ul style="margin:4px 0 0 18px; padding:0;">` +
        unresolved.slice(0,15).map(u=>`<li>${escapeHtml(u.productName)}: "${escapeHtml(u.raw)}"</li>`).join("") +
        (unresolved.length>15 ? `<li>…and ${unresolved.length-15} more</li>` : "") + `</ul>`;
    }
    results.innerHTML = html;
    flash.className = "flash show success";
    flash.textContent = "Done — the dashboard and Expiry Dates page reflect this immediately.";
    toast("success","Expiry date formats fixed.");
  }catch(err){
    flash.className="flash show error"; flash.textContent="Couldn't fix expiry dates: "+err.message;
  }finally{
    btn.disabled = false;
  }
});

document.getElementById("applyBulkThreshold").addEventListener("click", async ()=>{
  const val = Number(document.getElementById("bulkThreshold").value);
  if(isNaN(val) || val<0){ toast("error","Enter a valid non-negative number."); return; }
  const ok = await showConfirm({
    title:"Apply to every product?",
    body:`This sets the reorder threshold to ${val} for all ${activeProducts().length} products.`,
    okLabel:"Apply to all", danger:false
  });
  if(!ok) return;
  try{
    const batch = writeBatch(db);
    activeProducts().forEach(p=>batch.update(doc(db,"products",p.id), { reorderThreshold: val }));
    await batch.commit();
    toast("success","Reorder threshold updated for all products.");
  }catch(err){ toast("error","Couldn't update: "+err.message); }
});

async function wipeCollection(name){
  const snap = await getDocs(collection(db, name));
  const docs = snap.docs;
  for(let i=0;i<docs.length;i+=450){
    const batch = writeBatch(db);
    docs.slice(i,i+450).forEach(d=>batch.delete(d.ref));
    await batch.commit();
  }
}

document.getElementById("wipeAllDataBtn").addEventListener("click", async ()=>{
  // Deleting individual activity (ledger) entries is Admin-only everywhere else in this
  // app, so a Manager's wipe intentionally leaves the activity log untouched — it only
  // resets the catalog/directory. Only an Admin's wipe also clears the activity ledger.
  const alsoActivity = currentUser.role === "admin";
  const ok = await showConfirm({
    title:"Wipe data?",
    body: alsoActivity
      ? "This permanently erases every product, activity entry, client, and supplier for everyone using this portal. Team member accounts are kept. There is no undo."
      : "This permanently erases every product, client, and supplier for everyone using this portal (the activity/sales history is kept — only an Admin can also clear that). Team member accounts are kept. There is no undo.",
    okLabel:"Wipe data",
    requireText:"DELETE"
  });
  if(!ok) return;
  try{
    const jobs = [wipeCollection("products"), wipeCollection("clients"), wipeCollection("suppliers")];
    if(alsoActivity) jobs.push(wipeCollection("activity"));
    await Promise.all(jobs);
    toast("success","Data wiped.");
  }catch(err){ toast("error","Couldn't complete wipe: "+err.message); }
});
