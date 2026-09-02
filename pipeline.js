/* ------------------------------------------------------------------
   Plate Check — image pipeline
   ------------------------------------------------------------------
   Everything between "operator took a photo" and "word list ready for
   the copy engine". No operator boxing: regions are found automatically.

   PROOF  : find the entered Item # printed as a CAPTION under the
            artwork (not the "Product Number:" form field), then take
            the region directly above it, bounded by neighbouring
            captions. OCR that region.
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
var SHORT_OK = { OR:1, NO:1, WT:1, DV:1, LB:1, OZ:1, G:1, MG:1, PER:1, CUP:1, FAT:1, SAT:1, NET:1, SEA:1 };

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
  var idx = which === "green" ? 1 : which === "blue" ? 2 : 0;
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

/* ================= token merge ================= */
function keepable(t){
  var s = t.toUpperCase().replace(/[^A-Z0-9%./-]/g,"");
  if(!s) return false;
  if(/\d/.test(s)) return true;
  if(s.length <= 3) return !!SHORT_OK[s];
  return /[AEIOUY]/.test(s);
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

/* ================= proof: caption → artwork region ================= */
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
/* returns { found, onSheet, words } — words are merged tokens for the
   copy engine; found=false means the caption for `item` was not read */
function readProof(tess, paths, img, item, onProgress){
  var sheet = fit(img, { x:0, y:0, w:img.w, h:img.h }, WORK_W);
  var k = img.w / sheet.width;
  return readCanvas(tess, paths, sheet, ["green"], CONF_CAP, function(p){ if(onProgress) onProgress(p*0.35); })
    .then(function(raw){
      var reg = artworkRegion(raw, item, sheet.width);
      if(!reg.found) return { found:false, onSheet:reg.onSheet, words:[] };
      var box = { x:reg.box.x*k, y:reg.box.y*k, w:reg.box.w*k, h:reg.box.h*k };
      var art = fit(img, box, WORK_W);
      return readCanvas(tess, paths, art, ["green","blue"], CONF_MIN,
                        function(p){ if(onProgress) onProgress(0.35 + p*0.65); })
        .then(function(raw2){
          return { found:true, onSheet:reg.onSheet, words:merge(raw2).filter(notMeta), box:box };
        });
    });
}

/* Multi-across web in frame: the same long word appears several times at
   widely separated positions. Comparing that against a single proof
   artwork would report every repeat as extra copy, so it is refused. */
function multiLabel(words){
  var byText = {}, i, t;
  for(i=0;i<words.length;i++){
    t = words[i].text.toUpperCase();
    if(t.length < 6 || /\d/.test(t)) continue;
    (byText[t] = byText[t] || []).push(words[i]);
  }
  var keys = Object.keys(byText), k, list, xs, ys, spanX, spanY, maxW;
  for(k=0;k<keys.length;k++){
    list = byText[keys[k]];
    if(list.length < 3) continue;
    xs = list.map(function(w){ return w.x; }); ys = list.map(function(w){ return w.y; });
    maxW = Math.max.apply(null, list.map(function(w){ return w.w; }));
    spanX = Math.max.apply(null,xs) - Math.min.apply(null,xs);
    spanY = Math.max.apply(null,ys) - Math.min.apply(null,ys);
    if(spanX > maxW*2 || spanY > maxW*2) return true;
  }
  return false;
}

/* ================= public: read a press sample ================= */
function readPress(tess, paths, img, onProgress){
  var box = findLabel(img);
  var lab = fit(img, box, WORK_W);
  return readCanvas(tess, paths, lab, ["green","blue"], CONF_MIN, onProgress)
    .then(function(raw){
      var words = merge(raw);
      return { words:words, box:box, multi:multiLabel(words) };
    });
}

return { loadOriented:loadOriented, readProof:readProof, readPress:readPress,
         findLabel:findLabel, merge:merge, artworkRegion:artworkRegion };
})();
