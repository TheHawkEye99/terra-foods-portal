/* ============================================================================
   Terra Foods Portal — Cloud Functions
   The only server-side code in this project. Everything else (index.html,
   styles.css, app.js) is static and runs entirely in the browser + Firestore.

   Two functions:
     - sendWeeklyReports: runs once a day on a schedule, emails the 6 reports
       (as CSV attachments) to every Admin who has opted in for that day.
     - sendTestReportEmail: callable from the app's "Send me a test now"
       button, so an Admin can verify delivery immediately after setup.

   IMPORTANT — before deploying, change GMAIL_ADDRESS below to the Gmail
   address you generated an App Password for (see SETUP.md). Sending will
   fail until that's a real Gmail account with an App Password set as the
   GMAIL_APP_PASSWORD secret.
   ============================================================================ */

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

admin.initializeApp();
const db = admin.firestore();

const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");

const GMAIL_ADDRESS = "reports.terrafoods@gmail.com";

// Inferred from the app's existing en-IN / ₹ formatting throughout app.js.
// Change this if the business is actually based elsewhere.
const TIMEZONE = "Asia/Kolkata";

const EXPIRY_WARNING_DAYS = 30;

/* ============================== small shared helpers ==============================
   Mirrors the equivalent helpers in app.js so the numbers/format match exactly
   what admins already see in the app. ==================================== */

function fmtNum(n){ return Number(n||0).toLocaleString("en-IN"); }
function fmtMoney(n){ return "₹" + Math.round(n||0).toLocaleString("en-IN"); }

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

function diffDaysFromToday(dateStr){
  if(!dateStr) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const d = new Date(dateStr + "T00:00:00");
  return Math.round((d - today) / 86400000);
}

function todayDayName(timeZone){
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(new Date()).toLowerCase();
}

async function fetchAllData(){
  const [productsSnap, activitySnap] = await Promise.all([
    db.collection("products").get(),
    db.collection("activity").get()
  ]);
  const products = productsSnap.docs.map(d=>({ id:d.id, ...d.data() })).filter(p=>!p.archived);
  const activity = activitySnap.docs.map(d=>({ id:d.id, ...d.data() }));
  return { products, activity };
}

/* ============================== report builders ==============================
   Same calculations as app.js's reportStockValue / reportPriceList / reportSales /
   reportReorder / reportExpiry, re-implemented here against the Admin SDK since
   Cloud Functions can't import browser-side app.js directly. Keep these in sync
   if the report logic in app.js ever changes. ============================== */

function buildStockValueCsv(products){
  const rows = products.map(p=>{
    const cost = p.maxCost || p.cost || 0;
    const value = (p.stock||0) * cost;
    const damagedQty = p.damageTotal||0;
    const sampleQty = p.sampleTotal||0;
    return [p.name, p.pack||"", p.stock||0, cost, value, damagedQty, sampleQty];
  }).sort((a,b)=>b[4]-a[4]);
  return toCsv(["Product","Pack","Stock","Cost (highest)","Value","Damaged Qty","Sample Qty"], rows);
}

function buildPriceListCsv(products){
  const rows = products.map(p=>{
    const margin = p.cost>0 ? ((p.price-p.cost)/p.cost*100) : 0;
    return [p.name, p.pack||"", p.cost, p.price, margin.toFixed(1)];
  }).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
  return toCsv(["Product","Pack","Cost","Price","Margin %"], rows);
}

function buildReorderCsv(products){
  const rows = products.filter(p=>(p.stock||0) <= (p.reorderThreshold||0)).map(p=>{
    const shortfall = Math.max(0, (p.reorderThreshold||0) - (p.stock||0));
    return [p.name, p.pack||"", p.stock||0, p.reorderThreshold||0, shortfall];
  }).sort((a,b)=>a[2]-b[2]);
  return toCsv(["Product","Pack","Stock","Reorder At","Shortfall"], rows);
}

function buildExpiryCsv(products){
  const rows = [];
  for(const p of products){
    for(const b of (p.batches||[])){
      if(!b.expiryDate || b.qty<=0) continue;
      const dd = diffDaysFromToday(b.expiryDate);
      if(dd <= EXPIRY_WARNING_DAYS){
        rows.push([dd, p.name, p.pack||"", b.qty, b.expiryDate, dd<0 ? `${Math.abs(dd)}d overdue` : `${dd}d left`]);
      }
    }
  }
  rows.sort((a,b)=>a[0]-b[0]);
  return toCsv(["Product","Pack","Qty","Expiry Date","Status"], rows.map(r=>r.slice(1)));
}

function buildSalesCsv(activity){
  const byMonth = new Map();
  activity.filter(a=>a.type==="sale").forEach(a=>{
    const m = (a.date||"").slice(0,7);
    const cur = byMonth.get(m) || { qty:0, value:0 };
    cur.qty += a.qty; cur.value += a.qty*(a.price||0);
    byMonth.set(m, cur);
  });
  const rows = Array.from(byMonth.entries()).sort((a,b)=>b[0].localeCompare(a[0])).map(([m,v])=>[m, v.qty, v.value]);
  return toCsv(["Month","Units Sold","Revenue"], rows);
}

// The interactive Ledger report needs a user-picked date range; there's no picker in an
// unattended weekly email, so this defaults to the trailing 7 days (the only sensible
// bounded window for a recurring send — otherwise it'd dump the entire history every time).
function buildLedgerLast7DaysCsv(activity){
  const today = new Date(); today.setHours(0,0,0,0);
  const sevenDaysAgo = new Date(today.getTime() - 6*86400000); // inclusive 7-day window
  const fromStr = sevenDaysAgo.toISOString().slice(0,10);
  const toStr = today.toISOString().slice(0,10);
  const list = activity
    .filter(a=>(a.type==="sale"||a.type==="purchase") && (a.date||"") >= fromStr && (a.date||"") <= toStr)
    .slice().sort((a,b)=>(a.date||"").localeCompare(b.date||""));
  const rows = list.map(a=>[
    a.date||"", a.type, a.productName||"", a.qty, a.price||"",
    a.type==="sale" ? (a.party||"") : (a.vendor||""), a.note||""
  ]);
  return toCsv(["Date","Type","Product","Qty","Price","Party","Note"], rows);
}

async function buildAllReportAttachments(products, activity){
  const stamp = new Date().toISOString().slice(0,10);
  const csvs = [
    ["stock-value", buildStockValueCsv(products)],
    ["price-list", buildPriceListCsv(products)],
    ["sales", buildSalesCsv(activity)],
    ["reorder", buildReorderCsv(products)],
    ["expiry", buildExpiryCsv(products)],
    ["ledger-last-7-days", buildLedgerLast7DaysCsv(activity)]
  ];
  return csvs.map(([name, content])=>({
    filename: `${name}-${stamp}.csv`,
    content: Buffer.from(content, "utf8")
  }));
}

function summaryHtml(displayName, products){
  let stockValue = 0, totalStockQty = 0, reorderCount = 0;
  for(const p of products){
    const maxCost = p.maxCost || p.cost || 0;
    stockValue += (p.stock||0) * maxCost;
    totalStockQty += (p.stock||0);
    if((p.stock||0) <= (p.reorderThreshold||0)) reorderCount++;
  }
  return `
    <div style="font-family:-apple-system,Helvetica,Arial,sans-serif; color:#23291D; max-width:520px;">
      <div style="background:#3F5233; color:#FAF6EC; padding:18px 22px; border-radius:8px 8px 0 0;">
        <h2 style="margin:0; font-family:Georgia,serif; font-weight:normal;">Terra Foods — Weekly Report</h2>
      </div>
      <div style="border:1px solid #D8D0B8; border-top:none; padding:20px 22px; border-radius:0 0 8px 8px;">
        <p>Hi ${displayName || "there"},</p>
        <p>Here's your snapshot as of today, with the full detail attached as CSV files you can open directly in Excel or Google Sheets:</p>
        <ul style="line-height:1.8;">
          <li>Stock on hand: <strong>${fmtNum(totalStockQty)}</strong> units</li>
          <li>Stock value: <strong>${fmtMoney(stockValue)}</strong></li>
          <li>Items needing reorder: <strong>${fmtNum(reorderCount)}</strong></li>
        </ul>
        <p style="color:#6B6F5B; font-size:12.5px;">Attached: Stock Value, Price List &amp; Margins, Sales (month-wise), Reorder, Expiry, and the last 7 days of Sales &amp; Purchases.</p>
        <p style="color:#6B6F5B; font-size:12.5px;">You're getting this because you opted in from the portal's sidebar — turn it off any time from "Weekly email reports".</p>
      </div>
    </div>`;
}

let cachedTransporter = null;
function getTransporter(){
  if(!cachedTransporter){
    cachedTransporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: GMAIL_ADDRESS, pass: GMAIL_APP_PASSWORD.value() }
    });
  }
  return cachedTransporter;
}

async function sendReportEmailTo(email, displayName){
  const { products, activity } = await fetchAllData();
  const attachments = await buildAllReportAttachments(products, activity);
  await getTransporter().sendMail({
    from: `"Terra Foods Reports" <${GMAIL_ADDRESS}>`,
    to: email,
    subject: `Terra Foods — Weekly Report (${new Date().toISOString().slice(0,10)})`,
    html: summaryHtml(displayName, products),
    attachments
  });
}

/* ============================== the two exported functions ============================== */

exports.sendWeeklyReports = onSchedule(
  { schedule: "every day 07:00", timeZone: TIMEZONE, secrets: [GMAIL_APP_PASSWORD] },
  async () => {
    const today = todayDayName(TIMEZONE);
    const snap = await db.collection("users").where("role", "==", "admin").get();
    const targets = snap.docs
      .map(d=>({ id:d.id, ...d.data() }))
      .filter(u => u.active !== false && u.weeklyReportOptIn === true && u.weeklyReportDay === today && u.email);

    logger.info(`sendWeeklyReports: today is ${today}, ${targets.length} admin(s) opted in for today`);

    for(const u of targets){
      try{
        await sendReportEmailTo(u.email, u.displayName);
        logger.info(`Weekly report sent to ${u.email}`);
      }catch(err){
        logger.error(`Failed to send weekly report to ${u.email}: ${err.message}`);
      }
    }
  }
);

exports.sendTestReportEmail = onCall({ secrets: [GMAIL_APP_PASSWORD] }, async (request) => {
  if(!request.auth) throw new HttpsError("unauthenticated", "You must be signed in.");
  const callerDoc = await db.collection("users").doc(request.auth.uid).get();
  if(!callerDoc.exists || callerDoc.data().role !== "admin"){
    throw new HttpsError("permission-denied", "Only Admin accounts can send a test report.");
  }
  const caller = callerDoc.data();
  if(!caller.email) throw new HttpsError("failed-precondition", "Your account has no email on file.");
  try{
    await sendReportEmailTo(caller.email, caller.displayName);
    return { message: `Test email sent to ${caller.email}. Check your inbox (and spam folder) in a minute.` };
  }catch(err){
    logger.error(`sendTestReportEmail failed for ${caller.email}: ${err.message}`);
    throw new HttpsError("internal", "Couldn't send the email: " + err.message);
  }
});
