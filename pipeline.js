/* ------------------------------------------------------------------
   Plate Check — image pipeline
   ------------------------------------------------------------------
   Everything between "operator took a photo" and "word list ready for
   the copy engine". No operator boxing: regions are found automatically.

   PROOF  : the Item # is verified against the "Product Number:" field
            in the ART PROOF APPROVAL block(s) at the bottom of the
            sheet. Blocks are ordered top to bottom; artworks are found
            as dense regions above the first block and ordered left to
            right; block k pairs with artwork k. The caption under the
            artwork is NOT relied on — it is not always present.
   PRESS  : the photo is one label on a darker background. Find the
            label as the largest bright-or-saturated region and OCR it.

   Both crops are read twice — once on the GREEN channel (dark ink on
   light ground) and once on the BLUE channel (light type on blue or
   orange bands, which is invisible to grayscale). Sparse-text page
   segmentation is used because a label is scattered blocks, not a
   page of paragraphs. Readings that land on the same word slot are
   merged into ONE token carrying all candidate spellings, so the copy
   engine never sees the same word twice.

   All of this was tuned against real GLL photos; see README.
   ------------------------------------------------------------------ */
window.PlatePipeline = (function(){
"use strict";

var WORK_W   = 2600;  // OCR working width for a crop
var CONF_MIN = 60;    // reader confidence floor for copy tokens
var CONF_CAP = 50;    // lower floor when hunting the item caption (highlighter dims it)
var ITEM_RE  = /^\d{2}[-\u2013\u2014.\s]?\d{7}"?$/;
var INCH_RE  = /^\d+(\.\d+)?"$/;
var SHORT_OK = { OR:1, NO:1, WT:1, DV:1, LB:1, OZ:1, G:1, MG:1, TO:1, OF:1, IN:1, ON:1, BY:1, AT:1 };

/* ================= image loading (EXIF-safe) ================= */
/* Phone photos carry an orientation tag; the stored pixels may be
   rotated 90 or 180 degrees from how the photo displays. Reading a
   sideways image yields nothing. createImageBitmap with from-image
   applies the tag deterministically; the <img> fallback relies on the
   browser doing the same, which modern Safari does.                    */
function loadOriented(file){
  if(typeof createImageBitmap === "function"){
    return createImageBitmap(file, { imageOrientation: "from-image" })
      .catch(function(){ return createImageBitmap(file); })
      .then(function(bmp){ return { src:bmp, w:bmp.width, h:bmp.height }; })
      .catch(function(){ return loadViaImg(file); });
  }
  return loadViaImg(file);
}
function loadViaImg(file){
  return new Promise(function(res, rej){
    var url = URL.createObjectURL(file), im = new Image();
    im.onload = function(){ URL.revokeObjectURL(url); res({ src:im, w:im.naturalWidth, h:im.naturalHeight }); };
    im.onerror = function(){ URL.revokeObjectURL(url); rej(new Error("image decode failed")); };
    im.src = url;
  });
}

/* ================= canvas helpers ================= */
function draw(img, sx, sy, sw, sh, dw, dh){
  var c = document.createElement("canvas");
  c.width = dw; c.height = dh;
  var x = c.getContext("2d");
  x.imageSmoothingQuality = "high";
  x.drawImage(img.src, sx, sy, sw, sh, 0, 0, dw, dh);
  return c;
}
function fit(img, box, targetW){
  var s = targetW / box.w;
  return draw(img, box.x, box.y, box.w, box.h, Math.round(box.w*s), Math.round(box.h*s));
}
/* single-channel image, contrast-stretched, ready for the reader */
function channel(canvas, which){
  var x = canvas.getContext("2d");
  var id = x.getImageData(0,0,canvas.width,canvas.height), p = id.data, i, v, lo=255, hi=0;
  var idx = which === "green" ? 1 : which === "blue" ? 2 : 0;   /* "red" -> 0 */
  for(i=0;i<p.length;i+=4){
    v = which === "gray" ? (p[i]*0.299 + p[i+1]*0.587 + p[i+2]*0.114) : p[i+idx];
    p[i] = v;
    if(v<lo) lo=v; if(v>hi) hi=v;
  }
  var span = Math.max(1, hi-lo);
  for(i=0;i<p.length;i+=4){
    v = ((p[i]-lo)*255/span)|0; v = v<0?0:(v>255?255:v);
    p[i]=p[i+1]=p[i+2]=v; p[i+3]=255;
  }
  var out = document.createElement("canvas");
  out.width = canvas.width; out.height = canvas.height;
  out.getContext("2d").putImageData(id,0,0);
  return out;
}

/* ================= press label detection ================= */
/* Label = bright paper OR saturated ink. Background (table, liner) is
   dark AND neutral. Largest connected region of the mask is the label. */
function findLabel(img){
  var f = 8, w = Math.max(1, (img.w/f)|0), h = Math.max(1, (img.h/f)|0);
  var c = draw(img, 0,0,img.w,img.h, w,h);
  var p = c.getContext("2d").getImageData(0,0,w,h).data;
  var lum = new Float32Array(w*h), sat = new Float32Array(w*h), i, j=0, mean=0, mx=0;
  for(i=0;i<p.length;i+=4,j++){
    var r=p[i], g=p[i+1], b=p[i+2];
    lum[j] = r*0.299+g*0.587+b*0.114;
    sat[j] = Math.max(r,g,b)-Math.min(r,g,b);
    mean += lum[j]; if(lum[j]>mx) mx=lum[j];
  }
  mean /= (w*h);
  var thr = mean + 0.3*(mx-mean);
  var mask = new Uint8Array(w*h);
  for(j=0;j<w*h;j++) mask[j] = (lum[j] > thr || sat[j] > 60) ? 1 : 0;

  var seen = new Uint8Array(w*h), best=null, stack=[];
  for(var s=0;s<w*h;s++){
    if(!mask[s] || seen[s]) continue;
    stack.length=0; stack.push(s); seen[s]=1;
    var minx=w,maxx=0,miny=h,maxy=0,n=0;
    while(stack.length){
      var k=stack.pop(); n++;
      var px=k%w, py=(k-px)/w;
      if(px<minx)minx=px; if(px>maxx)maxx=px; if(py<miny)miny=py; if(py>maxy)maxy=py;
      var nb=[k-1,k+1,k-w,k+w];
      for(var q=0;q<4;q++){
        var m=nb[q];
        if(m<0||m>=w*h||seen[m]||!mask[m]) continue;
        if(q===0&&px===0) continue;
        if(q===1&&px===w-1) continue;
        seen[m]=1; stack.push(m);
      }
    }
    if(!best || n>best.n) best={n:n,minx:minx,maxx:maxx,miny:miny,maxy:maxy};
  }
  if(!best) return { x:0, y:0, w:img.w, h:img.h, whole:true };
  var pad = 2;
  var x0 = Math.max(0,(best.minx-pad))*f, y0 = Math.max(0,(best.miny-pad))*f;
  var x1 = Math.min(w-1,(best.maxx+pad))*f, y1 = Math.min(h-1,(best.maxy+pad))*f;
  var box = { x:x0, y:y0, w:Math.max(1,x1-x0), h:Math.max(1,y1-y0) };
  /* if the "label" is nearly the whole frame, the background was not
     darker than the label — fall back to the full photo */
  box.whole = (box.w*box.h) > 0.92*img.w*img.h;
  return box;
}

/* ================= OCR ================= */
var worker = null, workerReady = null;
function getWorker(tess, paths){
  if(workerReady) return workerReady;
  workerReady = tess.createWorker("eng", 1, {
    workerPath: paths.workerPath, corePath: paths.corePath, langPath: paths.langPath
  }).then(function(w){
    worker = w;
    return w.setParameters({ tessedit_pageseg_mode: "11" });  // sparse text
  }).then(function(){ return worker; });
  return workerReady;
}

/* read a canvas on the requested channels, return raw word boxes */
function readCanvas(tess, paths, canvas, channels, minConf, onProgress){
  return getWorker(tess, paths).then(function(w){
    var all = [], chain = Promise.resolve(), done = 0;
    channels.forEach(function(ch){
      chain = chain.then(function(){
        return w.recognize(channel(canvas, ch)).then(function(res){
          var words = (res.data && res.data.words) || [];
          words.forEach(function(wd){
            var t = String(wd.text||"").trim();
            if(!t || wd.confidence < minConf) return;
            var b = wd.bbox || {};
            all.push({ text:t, confidence:wd.confidence,
                       x:b.x0|0, y:b.y0|0, w:((b.x1-b.x0)|0)||1, h:((b.y1-b.y0)|0)||1, ch:ch });
          });
          done++; if(onProgress) onProgress(done/channels.length);
        });
      });
    });
    return chain.then(function(){ return all; });
  });
}

/* ================= colour bands ================= */
/* Classify each row of a crop by its dominant background — white paper,
   warm (orange/red/yellow), cool (blue), or dark neutral — and group
   contiguous rows into bands. Each band is then read on its own with the
   channel in which THAT background goes darkest. Reading the whole label
   at once lets the large blue area dominate the contrast stretch, which
   crushes cream-on-orange type to nothing; per-band contrast recovers it.
   Measured: the 60%-less-sodium line went from 4 mangled fragments to all
   14 words.                                                              */
var BAND_CH = { w:"green", o:"blue", b:"red", k:"gray" };

function classifyBands(canvas){
  var w = canvas.width, h = canvas.height;
  var d = canvas.getContext("2d").getImageData(0,0,w,h).data;
  var cls = new Array(h), y, x, i, counts, r, g, b, lum, sat, c;
  for(y=0;y<h;y++){
    counts = { w:0, o:0, b:0, k:0 };
    for(x=0;x<w;x+=2){
      i = (y*w+x)*4; r=d[i]; g=d[i+1]; b=d[i+2];
      lum = r*0.299+g*0.587+b*0.114; sat = Math.max(r,g,b)-Math.min(r,g,b);
      if(sat>80 && r>b && r>=g) c="o";
      else if(sat>80 && b>r) c="b";
      else if(lum<90) c="k";
      else c="w";
      counts[c]++;
    }
    cls[y] = counts.w>=counts.o && counts.w>=counts.b && counts.w>=counts.k ? "w"
           : counts.o>=counts.b && counts.o>=counts.k ? "o"
           : counts.b>=counts.k ? "b" : "k";
  }
  var out = [], cur = null, start = 0;
  for(y=0;y<h;y++){
    if(cls[y] !== cur){
      if(cur !== null && y-start > 8) out.push({ cls:cur, y0:start, y1:y });
      cur = cls[y]; start = y;
    }
  }
  if(h-start > 8) out.push({ cls:cur, y0:start, y1:h });
  var merged = [];
  out.forEach(function(bd){
    if(merged.length && merged[merged.length-1].cls === bd.cls) merged[merged.length-1].y1 = bd.y1;
    else merged.push(bd);
  });
  return merged.filter(function(bd){ return bd.y1-bd.y0 > h*0.03; });
}

/* read every band of a canvas on its own channel; boxes are returned in
   the canvas's coordinates so they merge with the whole-canvas passes  */
function readBands(tess, paths, canvas, minConf, onProgress){
  var bands = classifyBands(canvas), all = [], chain = Promise.resolve(), done = 0;
  if(!bands.length) return Promise.resolve([]);
  bands.forEach(function(bd){
    chain = chain.then(function(){
      var c = document.createElement("canvas");
      c.width = canvas.width; c.height = bd.y1-bd.y0;
      c.getContext("2d").drawImage(canvas, 0, bd.y0, canvas.width, bd.y1-bd.y0, 0, 0, c.width, c.height);
      return readCanvas(tess, paths, c, [BAND_CH[bd.cls]], minConf, null).then(function(raw){
        raw.forEach(function(r){ r.y += bd.y0; r.band = bd.cls; all.push(r); });
        done++; if(onProgress) onProgress(done/bands.length);
      });
    });
  });
  return chain.then(function(){ return all; });
}

/* ================= token merge ================= */
function keepable(t){
  var s = t.toUpperCase().replace(/[^A-Z0-9%./-]/g,"");
  if(!s) return false;
  if(/\d/.test(s)) return true;
  if(s.length <= 2) return !!SHORT_OK[s];          /* two letters: known units/words only */
  return /[AEIOUY]/.test(s);                       /* three or more: must contain a vowel */
}
/* Cluster readings that occupy the same word slot into one token with
   alternates. Primary = the LONGEST reading among those within 5 conf
   points of the best; fragments must not outrank whole words.         */
function merge(raw){
  var ws = raw.filter(function(r){ return keepable(r.text); })
              .sort(function(a,b){ return b.confidence-a.confidence; });
  var out = [], i, j;
  for(i=0;i<ws.length;i++){
    var w = ws[i], cx = w.x+w.w/2, cy = w.y+w.h/2, hit = null;
    for(j=0;j<out.length;j++){
      var o = out[j], ox = o.x+o.w/2, oy = o.y+o.h/2;
      if(Math.abs(cx-ox) < Math.max(w.w,o.w)*0.5 && Math.abs(cy-oy) < Math.max(w.h,o.h)*0.7){ hit=o; break; }
    }
    if(hit){
      if(hit.alts.indexOf(w.text) === -1) hit.alts.push(w.text);
      hit.reads.push(w);
    } else {
      out.push({ text:w.text, confidence:w.confidence, x:w.x, y:w.y, w:w.w, h:w.h,
                 alts:[w.text], reads:[w] });
    }
  }
  out.forEach(function(o){
    var top = o.reads[0].confidence, best = o.text;
    o.reads.forEach(function(r){ if(r.confidence >= top-5 && r.text.length > best.length) best = r.text; });
    o.text = best;
    delete o.reads;
  });
  return out.sort(function(a,b){ return ((a.y/40)|0) - ((b.y/40)|0) || a.x - b.x; });
}

/* ================= proof geometry ================= */
function comps(mask, w, h){
  var seen = new Uint8Array(w*h), out = [], stack = [], s;
  for(s=0;s<w*h;s++){
    if(!mask[s] || seen[s]) continue;
    stack.length=0; stack.push(s); seen[s]=1;
    var minx=w,maxx=0,miny=h,maxy=0,n=0;
    while(stack.length){
      var k=stack.pop(); n++;
      var px=k%w, py=(k-px)/w;
      if(px<minx)minx=px; if(px>maxx)maxx=px; if(py<miny)miny=py; if(py>maxy)maxy=py;
      var nb=[k-1,k+1,k-w,k+w];
      for(var q=0;q<4;q++){
        var m=nb[q];
        if(m<0||m>=w*h||seen[m]||!mask[m]) continue;
        if(q===0&&px===0) continue; if(q===1&&px===w-1) continue;
        seen[m]=1; stack.push(m);
      }
    }
    out.push({ n:n, x0:minx, y0:miny, x1:maxx+1, y1:maxy+1, fill:n/((maxx-minx+1)*(maxy-miny+1)) });
  }
  return out;
}
function lumSat(img, box, f){
  var p = pixels(img, box, 1/f), d = p.data, w = p.w, h = p.h;
  var lum = new Float32Array(w*h), sat = new Float32Array(w*h), i, j=0;
  for(i=0;i<d.length;i+=4,j++){
    var r=d[i],g=d[i+1],b=d[i+2];
    lum[j]=r*0.299+g*0.587+b*0.114; sat[j]=Math.max(r,g,b)-Math.min(r,g,b);
  }
  return { lum:lum, sat:sat, w:w, h:h };
}
function pixels(img, box, scale){
  var w = Math.max(1, Math.round(box.w*scale)), h = Math.max(1, Math.round(box.h*scale));
  var c = document.createElement("canvas"); c.width=w; c.height=h;
  var x = c.getContext("2d"); x.imageSmoothingQuality="high";
  x.drawImage(img.src, box.x, box.y, box.w, box.h, 0,0,w,h);
  return { data:x.getImageData(0,0,w,h).data, w:w, h:h };
}
function percentile(arr, p){
  var a = Array.prototype.slice.call(arr).sort(function(x,y){return x-y;});
  return a[Math.min(a.length-1, Math.floor(p*a.length))];
}
/* the sheet of paper: largest bright, low-saturation region */
function findPaper(img){
  var f = 16, L = lumSat(img, {x:0,y:0,w:img.w,h:img.h}, f);
  var thr = percentile(L.lum, 0.7)*0.8, mask = new Uint8Array(L.w*L.h), i;
  for(i=0;i<mask.length;i++) mask[i] = (L.lum[i]>thr && L.sat[i]<60) ? 1 : 0;
  var cs = comps(mask, L.w, L.h);
  if(!cs.length) return { x:0, y:0, w:img.w, h:img.h };
  var c = cs.reduce(function(a,b){ return b.n>a.n?b:a; });
  return { x:c.x0*f, y:c.y0*f, w:(c.x1-c.x0)*f, h:(c.y1-c.y0)*f };
}
/* dense non-paper regions above `limitY` (paper-relative), one per label
   column, left to right, padded. */
function findArtworks(img, paper, limitFrac){
  var f = 10, L = lumSat(img, paper, f), w = L.w, h = L.h;
  var limit = Math.round(h*limitFrac), i;
  var top = Array.prototype.slice.call(L.lum, 0, limit*w);
  var paperLum = percentile(top, 0.6);
  var mask = new Uint8Array(w*h), mg = Math.max(2, (w/60)|0), x, y;
  for(y=0;y<limit;y++) for(x=mg;x<w-mg;x++){
    if(y<mg) continue;
    i=y*w+x; mask[i] = (L.lum[i] < paperLum*0.62 || L.sat[i] > 45) ? 1 : 0;
  }
  var m = mask, it;
  for(it=0;it<3;it++){                         // dilate to knit a label together
    var o = new Uint8Array(w*h);
    for(y=0;y<h;y++) for(x=0;x<w;x++){
      i=y*w+x;
      o[i] = m[i] || (x>0&&m[i-1]) || (x<w-1&&m[i+1]) || (y>0&&m[i-w]) || (y<h-1&&m[i+w]) ? 1 : 0;
    }
    m = o;
  }
  var cands = comps(m, w, h).filter(function(c){
    return (c.x1-c.x0) > w*0.10 && (c.y1-c.y0) > h*0.03 && c.fill > 0.35;
  });
  cands = cands.filter(function(c){                     // drop glare envelopes
    return !cands.some(function(o){ return o!==c && o.x0>=c.x0 && o.x1<=c.x1 && o.y0>=c.y0 && o.y1<=c.y1; });
  });
  var changed = true, a, b, j;                           // one label = one column
  while(changed){
    changed = false;
    for(i=0;i<cands.length && !changed;i++) for(j=i+1;j<cands.length;j++){
      a=cands[i]; b=cands[j];
      var ox = Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0), narrow = Math.min(a.x1-a.x0, b.x1-b.x0);
      var gap = Math.max(a.y0,b.y0)-Math.min(a.y1,b.y1);
      if(ox > 0.6*narrow && gap < 0.15*h){
        cands[i] = { x0:Math.min(a.x0,b.x0), y0:Math.min(a.y0,b.y0), x1:Math.max(a.x1,b.x1), y1:Math.max(a.y1,b.y1), fill:1, n:a.n+b.n };
        cands.splice(j,1); changed = true; break;
      }
    }
  }
  return cands.filter(function(c){ return (c.x1-c.x0) > w*0.15 && (c.y1-c.y0) > h*0.08; })
    .sort(function(p,q){ return p.x0-q.x0; })
    .map(function(c){
      var pw=(c.x1-c.x0)*0.08, ph=(c.y1-c.y0)*0.08;
      var x0=Math.max(0,c.x0-pw), y0=Math.max(0,c.y0-ph), x1=Math.min(w,c.x1+pw), y1=Math.min(h,c.y1+ph);
      return { x:paper.x + x0*f, y:paper.y + y0*f, w:(x1-x0)*f, h:(y1-y0)*f };
    });
}

/* ================= proof: approval blocks ================= */
/* Read the lower part of the sheet on several channels. Each "Product"
   label followed on its line by an item-number token is an approval
   block. Blocks are grouped by line, ordered top to bottom, and every
   channel's reading of the number is kept as a candidate.              */
function approvalBlocks(raw){
  var anchors = raw.filter(function(r){ return /^PRODUCT/i.test(r.text); });
  var nums = raw.filter(function(r){ return ITEM_RE.test(r.text.replace(/\s+/g,"")); });
  var blocks = [];
  anchors.forEach(function(a){
    var line = nums.filter(function(n){ return Math.abs(n.y-a.y) < a.h*1.6 && n.x > a.x; });
    if(!line.length) return;
    var n = line.reduce(function(p,q){ return q.x<p.x?q:p; });
    var digits = normItem(n.text);
    var blk = blocks.filter(function(b){ return Math.abs(b.y - a.y) < a.h*3; })[0];
    if(!blk){ blk = { y:a.y, reads:[] }; blocks.push(blk); }
    blk.reads.push({ digits:digits, conf:n.confidence });
  });
  blocks.sort(function(p,q){ return p.y-q.y; });
  blocks.forEach(function(b){
    b.best = b.reads.reduce(function(p,q){ return q.conf>p.conf?q:p; });
  });
  return blocks;
}
function matchBlock(blocks, item){
  var want = normItem(item), i;
  for(i=0;i<blocks.length;i++){
    if(blocks[i].reads.some(function(r){ return r.digits === want && r.conf >= 25; })) return i;
  }
  return -1;
}

/* ================= proof: caption → artwork region (retained for reference, not used) ================= */
function normItem(s){ return String(s||"").replace(/\D/g,""); }

/* all occurrences of item-number-shaped tokens, no dedup */
function itemTokens(raw){
  return raw.filter(function(r){ return ITEM_RE.test(r.text.replace(/\s+/g,"")); });
}
/* a caption stands alone; a form field is preceded by "Product Number:" */
function isCaption(tok, raw){
  return !raw.some(function(q){
    return Math.abs(q.y - tok.y) < tok.h*1.5 && q.x < tok.x && (tok.x - q.x) < tok.w*4 &&
           /^(PRODUCT|NUMBER)/i.test(q.text);
  });
}
/* Given the full-sheet read, locate the caption for `item` and derive
   the artwork box above it, in the coordinates of the read canvas.    */
function artworkRegion(raw, item, canvasW){
  var want = normItem(item);
  var nums = itemTokens(raw);
  var caps = nums.filter(function(t){ return isCaption(t, raw); });
  var mine = caps.filter(function(t){ return normItem(t.text) === want; });
  var onSheet = [];
  caps.forEach(function(t){ var n = normItem(t.text); if(onSheet.indexOf(n)===-1) onSheet.push(n); });
  if(!mine.length) return { found:false, onSheet:onSheet };

  var c = mine.reduce(function(a,b){ return b.y < a.y ? b : a; });   // topmost occurrence
  var cx = c.x + c.w/2;
  var row = caps.filter(function(t){ return t !== c && Math.abs(t.y - c.y) < c.h*3; });
  var rights = row.filter(function(t){ return t.x > c.x + c.w; }).map(function(t){ return t.x + t.w/2; });
  var lefts  = row.filter(function(t){ return t.x + t.w < c.x; }).map(function(t){ return t.x + t.w/2; });
  var right = rights.length ? Math.min.apply(null, rights) : canvasW;
  var left  = lefts.length  ? Math.max.apply(null, lefts)  : 0;
  var x1 = Math.round((cx + right)/2);
  var x0 = lefts.length ? Math.round((left + cx)/2) : Math.max(0, Math.round(cx - (x1 - cx)));
  var y1 = Math.max(0, c.y - 10);
  var y0 = Math.max(0, Math.round(y1 - (x1 - x0)*1.15));
  return { found:true, onSheet:onSheet, box:{ x:x0, y:y0, w:x1-x0, h:y1-y0 }, caption:c };
}

/* strip sheet metadata that is not label copy */
function notMeta(tok){
  var t = tok.text.replace(/\s+/g,"");
  return !ITEM_RE.test(t) && !INCH_RE.test(t);
}

/* ================= public: read a proof ================= */
/* returns { found, onSheet, words, box, blockIndex }
   found=false → the Item # is not the Product Number of any approval block */
function readProof(tess, paths, img, item, onProgress){
  var paper = findPaper(img);
  // approval section: lower half of the paper, read on three channels
  var sec = { x:paper.x, y:paper.y + paper.h*0.5, w:paper.w, h:paper.h*0.5 };
  var secCanvas = fit(img, sec, WORK_W);
  return readCanvas(tess, paths, secCanvas, ["gray","green","red"], 0, function(p){ if(onProgress) onProgress(p*0.35); })
    .then(function(raw){
      var blocks = approvalBlocks(raw);
      var onSheet = blocks.map(function(b){ return b.best.conf >= 50 ? b.best.digits : null; }).filter(Boolean);
      var k = matchBlock(blocks, item);
      if(k < 0) return { found:false, onSheet:onSheet, words:[], blocks:blocks.length };

      // artwork lives above the approval section; first block's y marks the boundary
      var firstY = blocks.length ? (sec.y + blocks[0].y * (sec.w/secCanvas.width)) : (paper.y + paper.h*0.55);
      var limitFrac = Math.max(0.3, Math.min(0.7, (firstY - paper.y)/paper.h - 0.02));
      var arts = findArtworks(img, paper, limitFrac);
      var box = null;
      if(arts.length === 1) box = arts[0];
      else if(k < arts.length) box = arts[k];
      else if(arts.length) box = arts[arts.length-1];
      if(!box) return { found:true, onSheet:onSheet, words:[], noArtwork:true, blocks:blocks.length };

      var art = fit(img, box, WORK_W), raw2;
      return readCanvas(tess, paths, art, ["green","blue"], CONF_MIN,
                        function(p){ if(onProgress) onProgress(0.35 + p*0.35); })
        .then(function(r){ raw2 = r;
          return readBands(tess, paths, art, CONF_MIN, function(p){ if(onProgress) onProgress(0.70 + p*0.30); });
        })
        .then(function(rawB){
          return { found:true, onSheet:onSheet, words:merge(raw2.concat(rawB)).filter(notMeta),
                   box:box, blockIndex:k, artworks:arts.length, blocks:blocks.length };
        });
    });
}

/* ================= public: read a press sample ================= */
function readPress(tess, paths, img, onProgress){
  var box = findLabel(img);
  var lab = fit(img, box, WORK_W), raw1;
  return readCanvas(tess, paths, lab, ["green","blue"], CONF_MIN, function(p){ if(onProgress) onProgress(p*0.5); })
    .then(function(r){ raw1 = r;
      return readBands(tess, paths, lab, CONF_MIN, function(p){ if(onProgress) onProgress(0.5 + p*0.5); });
    })
    .then(function(rawB){
      var words = merge(raw1.concat(rawB));
      return { words:words, box:box, multi:multiLabel(words) };
    });
}

return { loadOriented:loadOriented, readProof:readProof, readPress:readPress,
         findLabel:findLabel, merge:merge, findPaper:findPaper, findArtworks:findArtworks,
         approvalBlocks:approvalBlocks, matchBlock:matchBlock };
})();
