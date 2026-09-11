/* ------------------------------------------------------------------
   Plate Check — job ticket barcodes
   ------------------------------------------------------------------
   Reads the Job # and Item Code barcodes off a photo of the GLL job
   ticket so the operator types nothing.

   Measured on a real ticket (Job 563254, yellow stock, sideways in
   frame, glare streak across the job barcode):
     Job  : Code 39   "563254"
     Item : Code 128  "10-9818112TICKET<tab>"   (scanner-form suffix)
     Step : Code 39   "1232" / "1233"           (ignored)

   Two-stage: LOCATE candidates cheaply (regions dense in edges across
   the bars, sparse along them — text is sparse, barcodes are dense),
   then DECODE each as a tight crop. Whole-image and strip scanning
   were tried and missed the widest code; tight crops read every time.

   1D decoding is sensitive to resampling — one crop read at 0.5x and
   0.8x but not 0.6x — so each candidate is tried at several sizes.
   Works in either orientation: vertical-bar regions are rotated
   upright before decoding.

   Requires the ZXing UMD build (global `ZXing`).
   ------------------------------------------------------------------ */
window.BarcodeRead = (function(){
"use strict";

var ITEM_RE = /(\d{2})-?(\d{7})/;
var JOB_RE  = /^\d{5,7}$/;

function gray(id){
  var g = new Uint8ClampedArray(id.width*id.height), d = id.data, i, j=0;
  for(i=0;i<d.length;i+=4,j++) g[j] = (d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114)|0;
  return g;
}
function canvas(w,h){ var c = document.createElement("canvas"); c.width=w; c.height=h; return c; }

/* ---------- locate ---------- */
function locate(img){
  var s = 1000/Math.max(img.w,img.h), W = Math.round(img.w*s), H = Math.round(img.h*s);
  var cv = canvas(W,H); cv.getContext("2d").drawImage(img.src, 0,0,img.w,img.h, 0,0,W,H);
  var g = gray(cv.getContext("2d").getImageData(0,0,W,H));
  var cands = [], vertical, x, y, i;

  for(var pass=0; pass<2; pass++){
    vertical = pass===1;
    var m = new Float32Array(W*H);
    for(y=1;y<H-1;y++) for(x=1;x<W-1;x++){
      var gx = Math.abs(g[y*W+x+1]-g[y*W+x-1]), gy = Math.abs(g[(y+1)*W+x]-g[(y-1)*W+x]);
      m[y*W+x] = Math.max(0, vertical ? gy-gx : gx-gy);
    }
    var rx = vertical?3:12, ry = vertical?12:3, f = new Float32Array(W*H), mx = 0;
    for(y=ry;y<H-ry;y++) for(x=rx;x<W-rx;x++){
      var acc = 0, dx, dy;
      for(dy=-ry;dy<=ry;dy+=3) for(dx=-rx;dx<=rx;dx+=3) acc += m[(y+dy)*W+x+dx];
      f[y*W+x] = acc; if(acc>mx) mx=acc;
    }
    var thr = mx*0.28, mask = new Uint8Array(W*H);
    for(i=0;i<W*H;i++) mask[i] = f[i]>thr ? 1 : 0;

    var seen = new Uint8Array(W*H), st = [];
    for(i=0;i<W*H;i++){
      if(!mask[i] || seen[i]) continue;
      st.length=0; st.push(i); seen[i]=1;
      var minx=W,maxx=0,miny=H,maxy=0,n=0;
      while(st.length){
        var k = st.pop(); n++;
        var px = k%W, py = (k-px)/W;
        if(px<minx)minx=px; if(px>maxx)maxx=px; if(py<miny)miny=py; if(py>maxy)maxy=py;
        var nb=[k-1,k+1,k-W,k+W], q;
        for(q=0;q<4;q++){ var r=nb[q]; if(r>=0&&r<W*H&&mask[r]&&!seen[r]){ seen[r]=1; st.push(r); } }
      }
      var bw = maxx-minx+1, bh = maxy-miny+1, ar = vertical ? bh/bw : bw/bh, fill = n/(bw*bh);
      if(n>40 && ar>1.5 && fill>0.45 && Math.max(bw,bh) > Math.max(W,H)*0.04){
        cands.push({ vertical:vertical, x:minx/s, y:miny/s, w:bw/s, h:bh/s });
      }
    }
  }

  /* merge pieces of one barcode split by glare, and stacked pairs:
     tolerant ALONG the bars, tight ACROSS them */
  var merged = true, a, b, j;
  while(merged){
    merged = false;
    for(i=0;i<cands.length && !merged;i++) for(j=i+1;j<cands.length;j++){
      a=cands[i]; b=cands[j];
      if(a.vertical !== b.vertical) continue;
      var gapX = Math.max(a.x,b.x)-Math.min(a.x+a.w,b.x+b.w), gapY = Math.max(a.y,b.y)-Math.min(a.y+a.h,b.y+b.h);
      var cross = a.vertical ? Math.max(a.w,b.w) : Math.max(a.h,b.h);
      var ok = a.vertical ? (gapX<cross*0.6 && gapY<cross*1.2) : (gapY<cross*0.6 && gapX<cross*1.2);
      if(ok){
        cands[i] = { vertical:a.vertical, x:Math.min(a.x,b.x), y:Math.min(a.y,b.y),
                     w:Math.max(a.x+a.w,b.x+b.w)-Math.min(a.x,b.x), h:Math.max(a.y+a.h,b.y+b.h)-Math.min(a.y,b.y) };
        cands.splice(j,1); merged = true; break;
      }
    }
  }
  return cands;
}

/* ---------- decode one candidate ---------- */
function decodeCandidate(img, c, Z){
  var along = c.vertical ? c.h : c.w, cross = c.vertical ? c.w : c.h;
  var pa = along*0.45, pc = cross*0.6, px = c.vertical?pc:pa, py = c.vertical?pa:pc;
  var x0 = Math.max(0,c.x-px), y0 = Math.max(0,c.y-py);
  var x1 = Math.min(img.w,c.x+c.w+px), y1 = Math.min(img.h,c.y+c.h+py);
  var cw = x1-x0, ch = y1-y0, long = c.vertical ? ch : cw;

  var hints = new Map();
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.ITF, Z.BarcodeFormat.CODE_93]);
  var reader = new Z.MultiFormatReader(); reader.setHints(hints);
  var out = [], targets = [1000,1400,700,1900], t;

  for(t=0;t<targets.length;t++){
    var sc = Math.min(2, Math.max(0.3, targets[t]/long));
    var W = Math.round((c.vertical?ch:cw)*sc), H = Math.round((c.vertical?cw:ch)*sc);
    var cv = canvas(W,H), x = cv.getContext("2d");
    if(c.vertical){ x.translate(W,0); x.rotate(Math.PI/2); x.drawImage(img.src, x0,y0,cw,ch, 0,0,H,W); }
    else x.drawImage(img.src, x0,y0,cw,ch, 0,0,W,H);
    for(var k=0;k<3;k++){
      var id = x.getImageData(0,0,W,H), lum = new Z.RGBLuminanceSource(gray(id),W,H), res = null;
      var bins = [new Z.HybridBinarizer(lum), new Z.GlobalHistogramBinarizer(lum)];
      for(var bi=0; bi<bins.length && !res; bi++){ try { res = reader.decode(new Z.BinaryBitmap(bins[bi])); } catch(e){ res = null; } }
      if(!res) break;
      var text = res.getText();
      if(!out.some(function(o){ return o.text===text; })) out.push({ text:text, format:Z.BarcodeFormat[res.getBarcodeFormat()] });
      var ys = res.getResultPoints().map(function(p){ return p.getY(); });
      var cy = (Math.min.apply(null,ys)+Math.max.apply(null,ys))/2;
      x.fillStyle="#fff"; x.fillRect(0, cy-H*0.22, W, H*0.44);
    }
    if(out.length) break;
  }
  return out;
}

/* ---------- classify ---------- */
function classify(reads){
  var job = null, item = null, i, t, m;
  for(i=0;i<reads.length;i++){
    t = String(reads[i].text||"").trim();
    m = ITEM_RE.exec(t);
    if(m && !item){ item = m[1] + "-" + m[2]; continue; }
    if(JOB_RE.test(t) && !job){ job = t; }
  }
  // if several job-shaped codes read, prefer six digits (GLL job numbers)
  if(!job){ var six = reads.map(function(r){ return String(r.text).trim(); }).filter(function(s){ return /^\d{6}$/.test(s); }); if(six.length) job = six[0]; }
  return { job:job, item:item };
}

/* ---------- public ---------- */
function scan(img){
  var Z = window.ZXing;
  if(!Z) return { ok:false, error:"barcode library not loaded", reads:[] };
  var t0 = Date.now(), cands = locate(img), reads = [], i, j;
  for(i=0;i<cands.length;i++){
    var rs = decodeCandidate(img, cands[i], Z);
    for(j=0;j<rs.length;j++) if(!reads.some(function(r){ return r.text===rs[j].text; })) reads.push(rs[j]);
  }
  var c = classify(reads);
  return { ok:!!(c.job||c.item), job:c.job, item:c.item, reads:reads, candidates:cands.length, ms:Date.now()-t0 };
}

return { scan:scan, locate:locate, classify:classify };
})();
