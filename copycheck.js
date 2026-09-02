/* ------------------------------------------------------------------
   Plate Check — copy difference engine
   ------------------------------------------------------------------
   Compares the WORDING read off the proof artwork against the wording
   read off the press sample, and reports which words differ.

   Not a pixel comparison. Layout shifts, print gain, registration and
   colour are all ignored by design — only the text is compared.

   The hard part is telling a real copy difference from an OCR misread.
   Three rules do that work:

     1. Words below a confidence floor are dropped from both sides and
        counted as blind spots, rather than reported as differences.
     2. Alphabetic words tolerate one character of edit distance, which
        absorbs the common OCR confusions.
     3. Tokens containing digits must match EXACTLY. No tolerance. A
        170/180 calorie difference is one character and is exactly the
        error this tool exists to catch.
   ------------------------------------------------------------------ */
window.CopyCheck = (function(){
"use strict";

var MIN_CONF = 60;      // drop words the reader was not confident about
var MIN_LEN  = 2;       // ignore stray single characters

/* ---------- pull words out of a Tesseract result ---------- */
function words(data){
  var out = [], i, w;
  if(data && data.words && data.words.length){
    for(i=0;i<data.words.length;i++){
      w = data.words[i];
      out.push({ text:String(w.text||"").trim(), conf: (w.confidence==null?100:w.confidence) });
    }
  } else {
    // older or reduced output: fall back to the flat text, no confidences
    var parts = String((data && data.text) || "").split(/\s+/);
    for(i=0;i<parts.length;i++) out.push({ text:parts[i].trim(), conf:100 });
  }
  return out;
}

/* ---------- normalise for comparison ---------- */
function clean(s){
  return String(s||"")
    .toUpperCase()
    .replace(/[\u2018\u2019\u201C\u201D]/g,"")
    .replace(/[^A-Z0-9%./-]/g,"")      // keep units and separators that carry meaning
    .replace(/^[.\-/]+|[.\-/]+$/g,"");
}
function hasDigit(s){ return /[0-9]/.test(s); }

/* Glyphs the reader routinely swaps. Collapsing each set to one symbol
   lets WLTH match WITH without loosening the rules for real words.
   Applied ONLY to tokens with no digits, so numeric exactness is safe. */
function canon(s){
  return s.replace(/[ILJ1]/g,"1").replace(/[OQD0]/g,"0")
          .replace(/[S5]/g,"5").replace(/[B8]/g,"8")
          .replace(/[CG6]/g,"6").replace(/[UV]/g,"V")
          .replace(/RN/g,"M").replace(/VV/g,"W");
}

/* ---------- prepare a token list ---------- */
function tokens(data){
  var raw = words(data), out = [], dropped = 0, i, t, c;
  for(i=0;i<raw.length;i++){
    t = clean(raw[i].text);
    if(!t || t.length < MIN_LEN) continue;
    c = raw[i].conf;
    if(c < MIN_CONF){ dropped++; continue; }
    out.push({ t:t, conf:c, num:hasDigit(t) });
  }
  return { list:out, dropped:dropped };
}

/* ---------- edit distance, capped ---------- */
function lev(a, b, cap){
  var la = a.length, lb = b.length;
  if(Math.abs(la-lb) > cap) return cap+1;
  var prev = new Array(lb+1), cur = new Array(lb+1), i, j;
  for(j=0;j<=lb;j++) prev[j] = j;
  for(i=1;i<=la;i++){
    cur[0] = i;
    var best = cur[0];
    for(j=1;j<=lb;j++){
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j-1] + 1,
        prev[j-1] + (a.charAt(i-1) === b.charAt(j-1) ? 0 : 1)
      );
      if(cur[j] < best) best = cur[j];
    }
    if(best > cap) return cap+1;
    for(j=0;j<=lb;j++) prev[j] = cur[j];
  }
  return prev[lb];
}

/* ---------- are two tokens the same word? ----------
   Numeric tokens: exact only. Alphabetic: one edit allowed once the
   word is long enough that a single OCR slip is more likely than a
   genuine one-letter copy change.                                     */
function same(a, b){
  if(a.t === b.t) return true;
  if(a.num || b.num) return false;             /* numbers: exact only */
  if(canon(a.t) === canon(b.t)) return true;   /* known glyph confusions */
  if(a.t.length < 5 || b.t.length < 5) return false;
  return lev(a.t, b.t, 1) <= 1;
}

/* ---------- longest common subsequence diff ---------- */
function diff(A, B){
  var n = A.length, m = B.length, i, j;
  var dp = [];
  for(i=0;i<=n;i++){ dp.push(new Uint16Array(m+1)); }
  for(i=n-1;i>=0;i--) for(j=m-1;j>=0;j--){
    dp[i][j] = same(A[i],B[j]) ? dp[i+1][j+1]+1 : Math.max(dp[i+1][j], dp[i][j+1]);
  }
  var ops = [];
  i = 0; j = 0;
  while(i<n && j<m){
    if(same(A[i],B[j])){ ops.push({op:"=", a:A[i], b:B[j]}); i++; j++; }
    else if(dp[i+1][j] >= dp[i][j+1]){ ops.push({op:"-", a:A[i]}); i++; }
    else { ops.push({op:"+", b:B[j]}); j++; }
  }
  while(i<n){ ops.push({op:"-", a:A[i]}); i++; }
  while(j<m){ ops.push({op:"+", b:B[j]}); j++; }
  return ops;
}

/* ---------- collapse adjacent -/+ into substitutions ---------- */
function findings(ops){
  var out = [], i = 0;
  while(i < ops.length){
    if(ops[i].op === "="){ i++; continue; }
    var minus = [], plus = [];
    while(i < ops.length && ops[i].op === "-"){ minus.push(ops[i].a); i++; }
    while(i < ops.length && ops[i].op === "+"){ plus.push(ops[i].b); i++; }
    if(minus.length && plus.length){
      out.push({ kind:"changed",
                 proof: minus.map(function(t){return t.t;}).join(" "),
                 press: plus.map(function(t){return t.t;}).join(" ") });
    } else if(minus.length){
      out.push({ kind:"missing", proof: minus.map(function(t){return t.t;}).join(" "), press:"" });
    } else if(plus.length){
      out.push({ kind:"extra", proof:"", press: plus.map(function(t){return t.t;}).join(" ") });
    }
  }
  return out;
}

/* ---------- main entry ---------- */
function compare(proofData, pressData){
  var P = tokens(proofData), S = tokens(pressData);

  /* If either side yielded almost nothing legible, the honest answer is
     "could not read it", not "the copy is missing". Reporting an entire
     label as a difference because of glare would train operators to
     ignore the tool. */
  var seenP = P.list.length + P.dropped, seenS = S.list.length + S.dropped;
  var thin  = P.list.length < 8 || S.list.length < 8;
  var noisy = (seenP + seenS) > 0 &&
              (P.dropped + S.dropped) / (seenP + seenS) > 0.4;
  if(thin || noisy){
    return {
      unreadable: true,
      findings: [],
      matched: 0,
      proofWords: P.list.length,
      pressWords: S.list.length,
      dropped: P.dropped + S.dropped,
      numericFindings: 0,
      proofText: P.list.map(function(t){return t.t;}).join(" "),
      pressText: S.list.map(function(t){return t.t;}).join(" ")
    };
  }
  var ops = diff(P.list, S.list);
  var f = findings(ops);
  var matched = 0, k;
  for(k=0;k<ops.length;k++) if(ops[k].op === "=") matched++;

  var numeric = f.filter(function(x){
    return /[0-9]/.test(x.proof) || /[0-9]/.test(x.press);
  }).length;

  return {
    unreadable: false,
    findings: f,
    matched: matched,
    proofWords: P.list.length,
    pressWords: S.list.length,
    dropped: P.dropped + S.dropped,
    numericFindings: numeric,
    proofText: P.list.map(function(t){return t.t;}).join(" "),
    pressText: S.list.map(function(t){return t.t;}).join(" ")
  };
}

return { compare: compare, MIN_CONF: MIN_CONF };
})();
