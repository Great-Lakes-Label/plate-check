/* ------------------------------------------------------------------
   Plate Check — SharePoint sync
   ------------------------------------------------------------------
   Local storage is the source of truth. This module mirrors each
   completed check to a SharePoint list, queues anything that fails,
   and retries in the background. It never blocks the operator.

   Configure MODE below, then include before the main script:
     <script src="sync.js"></script>
   ------------------------------------------------------------------ */
window.PlateSync = (function(){
"use strict";

var CONFIG = {

  // "flow"  = Power Automate HTTP trigger. Fast to stand up.
  // "graph" = Entra app registration + Microsoft Graph. Proper auth.
  // "off"   = local only.
  MODE: "off",

  // ---- MODE "flow" ----
  // Paste the HTTP POST URL from the flow's trigger. Note that this URL
  // contains its own access signature: anyone who can read this file can
  // write rows to the list. See README before using on a public site.
  FLOW_URL: "",

  // ---- MODE "graph" ----
  GRAPH: {
    clientId: "",                                   // Entra app (client) ID
    tenantId: "",                                   // GLL tenant ID
    siteHost: "greatlakeslabel.sharepoint.com",
    sitePath: "/sites/Operations",                  // server-relative site path
    listName: "Plate Check Log"
  },

  RETRY_MS: 60000   // how often to drain the queue
};

var QKEY = "gll.platecheck.queue.v1";
var DKEY = "gll.platecheck.device.v1";

/* ---------- storage that degrades instead of throwing ---------- */
var mem = {};
function get(k){ try { return localStorage.getItem(k); } catch(e){ return mem[k] || null; } }
function set(k,v){ try { localStorage.setItem(k,v); } catch(e){ mem[k]=v; } }

/* ---------- device tag, set once per tablet ---------- */
function deviceTag(){
  var d = get(DKEY);
  if(!d){
    d = (prompt("One-time setup — which press or station is this tablet on? (e.g. Press 4)") || "unassigned").trim();
    set(DKEY, d);
  }
  return d;
}
function setDeviceTag(v){ set(DKEY, String(v||"").trim()); }

/* ---------- queue ---------- */
function readQ(){ try { return JSON.parse(get(QKEY) || "[]"); } catch(e){ return []; } }
function writeQ(q){ set(QKEY, JSON.stringify(q.slice(-500))); }
function queueDepth(){ return readQ().length; }

/* ---------- public entry point ---------- */
function send(row){
  if(CONFIG.MODE === "off") return;
  var payload = {
    Title:        row.job,
    ItemNumber:   row.item || "",
    CheckedAt:    row.t,
    Customer:     row.cust || "",
    ExpectedCode: row.exp || "",
    CodeRead:     row.got || "",
    Result:       ({go:"Match", stop:"Stop", hold:"No read"})[row.v] || row.v,
    Operator:     row.operator || "",
    Station:      deviceTag()
  };
  var q = readQ();
  q.push(payload);
  writeQ(q);
  drain();
}

/* ---------- drain the queue ---------- */
var draining = false;
function drain(){
  if(draining || CONFIG.MODE === "off") return;
  if(!navigator.onLine) return;
  var q = readQ();
  if(!q.length) return;

  draining = true;
  var post = (CONFIG.MODE === "graph") ? postGraph : postFlow;

  post(q[0]).then(function(){
    var rest = readQ();
    rest.shift();
    writeQ(rest);
    draining = false;
    if(rest.length) drain();          // keep going while it's working
    announce();
  }).catch(function(){
    draining = false;                 // leave it queued, try again later
    announce();
  });
}

/* ---------- MODE "flow" ----------
   Sent as text/plain on purpose. A JSON content-type triggers a CORS
   preflight, which Power Automate's HTTP trigger does not answer, so the
   request fails before it leaves the browser. text/plain is a "simple
   request" and goes through. Parse it in the flow with json(triggerBody()).
   The response is still unreadable cross-origin, so a resolved promise
   means "sent", not "written" — the list is the confirmation.            */
function postFlow(payload){
  if(!CONFIG.FLOW_URL) return Promise.reject(new Error("FLOW_URL not set"));
  return fetch(CONFIG.FLOW_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(payload)
  }).then(function(r){
    if(!r.ok && r.status !== 0) throw new Error("HTTP " + r.status);
  });
}

/* ---------- MODE "graph" ----------
   Requires MSAL.js on the page:
   <script src="https://alcdn.msauth.net/browser/2.38.3/js/msal-browser.min.js"></script>
   and an Entra app registration with delegated Sites.ReadWrite.All,
   redirect URI set to the Pages URL, platform "Single-page application". */
var msal = null, siteId = null, listId = null;

function msalApp(){
  if(msal) return msal;
  if(typeof window.msal === "undefined") throw new Error("MSAL not loaded");
  msal = new window.msal.PublicClientApplication({
    auth: {
      clientId: CONFIG.GRAPH.clientId,
      authority: "https://login.microsoftonline.com/" + CONFIG.GRAPH.tenantId,
      redirectUri: window.location.origin + window.location.pathname
    },
    cache: { cacheLocation: "localStorage" }   // survives tablet restarts
  });
  return msal;
}

function token(){
  var app = msalApp();
  var scopes = ["Sites.ReadWrite.All"];
  return app.initialize().then(function(){
    var accts = app.getAllAccounts();
    if(accts.length){
      return app.acquireTokenSilent({ scopes: scopes, account: accts[0] })
        .catch(function(){ return app.acquireTokenPopup({ scopes: scopes }); });
    }
    return app.acquireTokenPopup({ scopes: scopes });
  }).then(function(r){ return r.accessToken; });
}

function graph(url, tok, opts){
  opts = opts || {};
  opts.headers = Object.assign({
    Authorization: "Bearer " + tok,
    "Content-Type": "application/json"
  }, opts.headers || {});
  return fetch("https://graph.microsoft.com/v1.0" + url, opts).then(function(r){
    if(!r.ok) throw new Error("Graph " + r.status);
    return r.json();
  });
}

function resolveList(tok){
  if(listId) return Promise.resolve();
  var g = CONFIG.GRAPH;
  return graph("/sites/" + g.siteHost + ":" + g.sitePath, tok)
    .then(function(site){
      siteId = site.id;
      return graph("/sites/" + siteId + "/lists?$select=id,name,displayName", tok);
    })
    .then(function(res){
      var hit = (res.value || []).filter(function(l){
        return l.displayName === g.listName || l.name === g.listName;
      })[0];
      if(!hit) throw new Error("List not found: " + g.listName);
      listId = hit.id;
    });
}

function postGraph(payload){
  var tok;
  return token()
    .then(function(t){ tok = t; return resolveList(tok); })
    .then(function(){
      return graph("/sites/" + siteId + "/lists/" + listId + "/items", tok, {
        method: "POST",
        body: JSON.stringify({ fields: payload })
      });
    });
}

/* ---------- status for the UI ---------- */
function announce(){
  document.dispatchEvent(new CustomEvent("platesync", {
    detail: { queued: queueDepth(), mode: CONFIG.MODE, online: navigator.onLine }
  }));
}

window.addEventListener("online", drain);
setInterval(drain, CONFIG.RETRY_MS);
document.addEventListener("DOMContentLoaded", function(){ setTimeout(drain, 2000); });

return {
  send: send,
  drain: drain,
  queueDepth: queueDepth,
  setDeviceTag: setDeviceTag,
  config: CONFIG
};
})();
