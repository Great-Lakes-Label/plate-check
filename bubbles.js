/* ------------------------------------------------------------------
   Plate Check — nutrition bubble comparison
   ------------------------------------------------------------------
   The small numeric callouts (180 CALORIES, 2.5g SAT FAT, 35mg SODIUM,
   0g ADDED SUGARS) defeat OCR: in this condensed face Tesseract reads
   5 as 9 at 84% confidence, which is a wrong value, not a gap.

   So these are not READ. They are COMPARED. Each white callout shape is
   found on both the proof artwork and the press sample, the number line
   inside it is isolated and binarised, stroke weight is normalised, and
   the two shapes are matched with a distance-tolerant score. A changed
   digit shows as a large shape difference; no recognition is involved,
   so no glyph confusion is possible.

   Measured on real GLL photos at press-quality resolution:
     same number, second photo (shifted, blurred, rescaled): 0.000-0.002
     one digit changed:                                      ~0.11
     different numbers:                                      0.31-0.58
   THRESHOLD below sits in the gap.

   The operator still reads the values — both crops are shown side by
   side. The tool's job is to say which bubble to look at.
   ------------------------------------------------------------------ */
window.BubbleCheck = (function(){
"use strict";

var THRESHOLD = 0.05;   // shape mismatch above this = the number differs
var NORM_H    = 64;     // number line normalised to this height
var UPSCALE   = 3;

/* ---------- Otsu threshold ---------- */
function otsu(vals){
  var hist = new Float64Array(256), i, n = vals.length;
  for(i=0;i<n;i++) hist[vals[i]|0]++;
  var sum1 = 0; for(i=0;i<256;i++) sum1 += i*hist[i];
  var sumB=0, wB=0, maxv=0, thr=0, t, wF, mB, mF, v;
  for(t=0;t<256;t++){
    wB += hist[t]; if(!wB) continue;
    wF = n - wB;  if(!wF) break;
    sumB += t*hist[t]; mB = sumB/wB; mF = (sum1-sumB)/wF;
    v = wB*wF*(mB-mF)*(mB-mF);
    if(v>maxv){ maxv=v; thr=t; }
  }
  return thr;
}

/* ---------- pixels of a region as arrays ---------- */
function pixels(img, box, scale){
  var w = Math.max(1, Math.round(box.w*scale)), h = Math.max(1, Math.round(box.h*scale));
  var c = document.createElement("canvas"); c.width = w; c.height = h;
  var x = c.getContext("2d"); x.imageSmoothingQuality = "high";
  x.drawImage(img.src, box.x, box.y, box.w, box.h, 0, 0, w, h);
  return { data: x.getImageData(0,0,w,h).data, w:w, h:h };
}

/* ---------- find white callout shapes on a coloured band ---------- */
/* Works on a downsampled copy of the region. Returns boxes in region
   coordinates, left to right.                                         */
function findBubbles(img, region){
  var f = Math.max(1, Math.round(region.w/300));
  var p = pixels(img, region, 1/f), d = p.data, w = p.w, h = p.h;
  var mask = new Uint8Array(w*h), lums = new Uint8Array(w*h), i, j=0, r, g, b, lum, sat;
  for(i=0;i<d.length;i+=4,j++){
    r=d[i]; g=d[i+1]; b=d[i+2];
    lums[j] = (r*0.299+g*0.587+b*0.114)|0;
  }
  /* Bubbles are the brightest thing in the strip. Anchor the threshold to
     the brightest pixels present (99th percentile) so exposure differences
     cancel, and clamp it well above the blue band so lighter blue can never
     bridge two bubbles into one blob. Otsu was tried and rejected: on a
     strip dominated by blue it splits inside the blue and merges bubbles. */
  var hist = new Int32Array(256), q;
  for(q=0;q<lums.length;q++) hist[lums[q]]++;
  var acc=0, p99=255, target=0.99*lums.length;
  for(q=0;q<256;q++){ acc+=hist[q]; if(acc>=target){ p99=q; break; } }
  var whiteThr = Math.min(155, Math.max(135, Math.round(p99*0.62)));
  j = 0;
  for(i=0;i<d.length;i+=4,j++){
    r=d[i]; g=d[i+1]; b=d[i+2];
    sat = Math.max(r,g,b)-Math.min(r,g,b);
    mask[j] = (lums[j] > whiteThr && sat < 80) ? 1 : 0;
  }
  var seen = new Uint8Array(w*h), stack = [], out = [];
  for(var s=0;s<w*h;s++){
    if(!mask[s] || seen[s]) continue;
    stack.length = 0; stack.push(s); seen[s]=1;
    var minx=w,maxx=0,miny=h,maxy=0,n=0;
    while(stack.length){
      var k = stack.pop(); n++;
      var px = k%w, py = (k-px)/w;
      if(px<minx)minx=px; if(px>maxx)maxx=px; if(py<miny)miny=py; if(py>maxy)maxy=py;
      var nb=[k-1,k+1,k-w,k+w];
      for(var q=0;q<4;q++){
        var m=nb[q];
        if(m<0||m>=w*h||seen[m]||!mask[m]) continue;
        if(q===0&&px===0) continue; if(q===1&&px===w-1) continue;
        seen[m]=1; stack.push(m);
      }
    }
    if(n < 0.004*w*h) continue;
    var bw=(maxx-minx+1), bh=(maxy-miny+1);
    // callouts are roughly upright rectangles, not the band or specks
    if(bw/bh > 0.5 && bw/bh < 1.6 && bh > h*0.05){
      out.push({ x:region.x + minx*f, y:region.y + miny*f, w:bw*f, h:bh*f });
    }
  }
  return out.sort(function(a,b){ return a.x-b.x; });
}

/* ---------- isolate the number line inside one bubble ---------- */
function numberLine(img, box){
  var p = pixels(img, box, UPSCALE), d = p.data, W = p.w, H = p.h;
  var red = new Uint8Array(W*H), i, j=0;
  for(i=0;i<d.length;i+=4,j++) red[j] = d[i];          // red channel: blue ink darkest
  var thr = otsu(red);

  // rounded-rect mask to drop the bubble edge and corners
  var inset = Math.round(W*0.08), rad = Math.round(W*0.25);
  var mc = document.createElement("canvas"); mc.width=W; mc.height=H;
  var mx = mc.getContext("2d");
  mx.fillStyle="#000"; mx.fillRect(0,0,W,H);
  mx.fillStyle="#fff"; mx.beginPath();
  if(mx.roundRect) mx.roundRect(inset,inset,W-2*inset,H-2*inset,rad); else mx.rect(inset,inset,W-2*inset,H-2*inset);
  mx.fill();
  var md = mx.getImageData(0,0,W,H).data;

  var ink = new Uint8Array(W*H), maskW = new Int32Array(H), y, x;
  for(y=0;y<H;y++) for(x=0;x<W;x++){
    i = y*W+x;
    var inside = md[i*4] > 128;
    if(inside) maskW[y]++;
    ink[i] = (inside && red[i] < thr) ? 1 : 0;
  }

  // dome: a lower-half row whose LONGEST CONTIGUOUS ink run spans most of
  // the bubble. Bold digits have gaps between glyphs; the dome does not.
  var domeY = H;
  for(y=(H/2)|0; y<H; y++){
    var best=0, cur=0;
    for(x=0;x<W;x++){ cur = ink[y*W+x] ? cur+1 : 0; if(cur>best) best=cur; }
    if(best > 0.6*maskW[y] && maskW[y]>0){ domeY = y; break; }
  }
  for(y=domeY;y<H;y++) for(x=0;x<W;x++) ink[y*W+x]=0;

  // first text band, judged on central columns
  var c0=(W*0.15)|0, c1=(W*0.85)|0, rows=new Uint8Array(H);
  for(y=0;y<domeY;y++){
    var cnt=0; for(x=c0;x<c1;x++) cnt += ink[y*W+x];
    rows[y] = cnt/(c1-c0) > 0.01 ? 1 : 0;
  }
  var bands=[], inb=false, st=0;
  for(y=0;y<domeY;y++){
    if(rows[y] && !inb){ st=y; inb=true; }
    if(!rows[y] && inb){ if(y-st > H*0.08) bands.push([st,y]); inb=false; }
  }
  if(inb && domeY-st > H*0.08) bands.push([st,domeY]);
  if(!bands.length) return null;

  var y0=bands[0][0], y1=bands[0][1], minx=W, maxx=-1;
  for(y=y0;y<y1;y++) for(x=0;x<W;x++) if(ink[y*W+x]){ if(x<minx)minx=x; if(x>maxx)maxx=x; }
  if(maxx<0) return null;
  var lw = maxx-minx+1, lh = y1-y0, line = new Uint8Array(lw*lh);
  for(y=0;y<lh;y++) for(x=0;x<lw;x++) line[y*lw+x] = ink[(y0+y)*W + (minx+x)];
  return { d:line, w:lw, h:lh };
}

/* ---------- normalise height and stroke weight ---------- */
function normalise(line){
  var h = NORM_H, w = Math.max(8, Math.round(line.w*h/line.h));
  // bilinear-ish resample via canvas for quality
  var src = document.createElement("canvas"); src.width=line.w; src.height=line.h;
  var sd = src.getContext("2d").createImageData(line.w, line.h), i;
  for(i=0;i<line.d.length;i++){ var v = line.d[i]?0:255; sd.data[i*4]=sd.data[i*4+1]=sd.data[i*4+2]=v; sd.data[i*4+3]=255; }
  src.getContext("2d").putImageData(sd,0,0);
  var dst = document.createElement("canvas"); dst.width=w; dst.height=h;
  var dx = dst.getContext("2d"); dx.imageSmoothingQuality="high"; dx.drawImage(src,0,0,w,h);
  var dd = dx.getImageData(0,0,w,h).data;
  var a = new Uint8Array(w*h), n=0;
  for(i=0;i<w*h;i++){ a[i] = dd[i*4] < 128 ? 1 : 0; n += a[i]; }

  // erode toward a common ink fraction so stroke weight cancels out
  var target = 0.55*n, cur = n;
  function erode(m){
    var o = new Uint8Array(w*h), cnt=0, x, y;
    for(y=1;y<h-1;y++) for(x=1;x<w-1;x++){
      var k=y*w+x;
      if(m[k]&&m[k-1]&&m[k+1]&&m[k-w]&&m[k+w]){ o[k]=1; cnt++; }
    }
    return { m:o, n:cnt };
  }
  while(cur > target && cur > 50){
    var e = erode(a);
    if(e.n < 50) break;
    a = e.m; cur = e.n;
  }
  return { d:a, w:w, h:h };
}

/* ---------- distance-tolerant mismatch ---------- */
function score(A, B){
  var w = Math.max(A.w,B.w), h = NORM_H;
  function pad(X){
    var o = new Uint8Array(w*h), off=((w-X.w)/2)|0, x, y;
    for(y=0;y<h;y++) for(x=0;x<X.w;x++) o[y*w+off+x] = X.d[y*X.w+x];
    return o;
  }
  function near(M, r){
    var o = new Uint8Array(w*h), x, y, dx, dy;
    for(y=0;y<h;y++) for(x=0;x<w;x++){
      if(!M[y*w+x]) continue;
      for(dy=-r;dy<=r;dy++) for(dx=-r;dx<=r;dx++){
        var yy=y+dy, xx=x+dx;
        if(yy>=0&&yy<h&&xx>=0&&xx<w) o[yy*w+xx]=1;
      }
    }
    return o;
  }
  var a = pad(A), b0 = pad(B), na = near(a,3);
  var best = 1, shift;
  for(shift=-8; shift<=8; shift+=2){
    var b = new Uint8Array(w*h), x, y;
    for(y=0;y<h;y++) for(x=0;x<w;x++){ var sx=x-shift; if(sx>=0&&sx<w) b[y*w+x]=b0[y*w+sx]; }
    var nb = near(b,3), miss=0, tot=0, i;
    for(i=0;i<w*h;i++){
      if(a[i]){ tot++; if(!nb[i]) miss++; }
      if(b[i]){ tot++; if(!na[i]) miss++; }
    }
    var s = tot ? miss/tot : 0;
    if(s<best) best=s;
  }
  return best;
}

/* ---------- render a normalised line to a small canvas ---------- */
function toCanvas(N){
  var c = document.createElement("canvas"); c.width=N.w; c.height=N.h;
  var id = c.getContext("2d").createImageData(N.w,N.h), i;
  for(i=0;i<N.d.length;i++){ var v=N.d[i]?20:255; id.data[i*4]=id.data[i*4+1]=id.data[i*4+2]=v; id.data[i*4+3]=255; }
  c.getContext("2d").putImageData(id,0,0);
  return c;
}
function cropCanvas(img, box, w){
  var h = Math.round(box.h*w/box.w);
  var c = document.createElement("canvas"); c.width=w; c.height=h;
  var x = c.getContext("2d"); x.imageSmoothingQuality="high";
  x.drawImage(img.src, box.x, box.y, box.w, box.h, 0,0,w,h);
  return c;
}

/* ---------- public ----------
   proofImg/pressImg: oriented images ({src,w,h}); proofBox/pressBox: the
   artwork / label boxes already located by the pipeline. The bubble
   strip is assumed to be in the lower part of each.                   */
function compare(proofImg, proofBox, pressImg, pressBox){
  function strip(box){ return { x:box.x, y:box.y + box.h*0.55, w:box.w, h:box.h*0.45 }; }
  var pb = findBubbles(proofImg, strip(proofBox));
  var sb = findBubbles(pressImg, strip(pressBox));
  var PA = pb.map(function(b){ var L = numberLine(proofImg, b); return L ? normalise(L) : null; });
  var SA = sb.map(function(b){ var L = numberLine(pressImg, b); return L ? normalise(L) : null; });

  /* The bubbles are an evenly spaced row on both sides. If one side lost
     a bubble, slide the shorter row along the longer and keep the offset
     whose matched pairs agree best. Unmatched bubbles are reported as
     unresolved, never as differences.                                   */
  var longP = pb.length >= sb.length;
  var L = longP ? PA : SA, S = longP ? SA : PA;
  var bestOff = 0, bestMean = Infinity, off, i, k;
  for(off=0; off<=L.length-S.length; off++){
    var tot=0, cnt=0;
    for(i=0;i<S.length;i++){
      if(S[i] && L[i+off]){ tot += score(S[i], L[i+off]); cnt++; }
    }
    var mean = cnt ? tot/cnt : Infinity;
    if(mean < bestMean){ bestMean = mean; bestOff = off; }
  }

  var out = [], n = Math.max(pb.length, sb.length);
  for(k=0;k<n;k++){
    var pi = longP ? k : k - bestOff;      // index into proof list
    var si = longP ? k - bestOff : k;      // index into press list
    var hasP = pi>=0 && pi<pb.length, hasS = si>=0 && si<sb.length;
    var entry = { index:k,
      proofBox: hasP ? pb[pi] : null, pressBox: hasS ? sb[si] : null,
      proofCrop: hasP ? cropCanvas(proofImg, pb[pi], 140) : null,
      pressCrop: hasS ? cropCanvas(pressImg, sb[si], 140) : null };
    if(hasP && hasS && PA[pi] && SA[si]){
      var sc = score(PA[pi], SA[si]);
      entry.score = sc; entry.status = sc > THRESHOLD ? "differs" : "same";
    } else { entry.score = null; entry.status = "unresolved"; }
    out.push(entry);
  }
  return { bubbles:out, proofCount:pb.length, pressCount:sb.length,
           countMismatch: pb.length !== sb.length, threshold:THRESHOLD };
}

return { compare:compare, findBubbles:findBubbles, THRESHOLD:THRESHOLD };
})();
