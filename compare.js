/* ------------------------------------------------------------------
   Plate Check — copy comparison across two photos
   ------------------------------------------------------------------
   Compares a boxed region from the proof photo against a boxed region
   from the press-sample photo. Reports differences in text, layout and
   structure.

   Copy only. Colour is not evaluated — the Art Proof Approval is not a
   colour standard, so any colour verdict drawn from it would mislead.

   Two separate handheld photos can differ in scale AND rotation, so the
   alignment search covers both. Normalising each region to the same
   working size absorbs scale; a coarse angle sweep absorbs rotation.
   ------------------------------------------------------------------ */
window.PlateCompare = (function(){
"use strict";

var W = 768;            /* working width for both regions. Raising this
                           improves character-level sensitivity: ink area
                           grows with the square of resolution while
                           registration edge artefacts grow only linearly,
                           so the two separate as W increases. */
var MIN_BLOB = 320;     // ignore difference blobs smaller than this (px area)
var MIN_SIDE = 8;       // and blobs thinner than this (edge-misalignment slivers)
var ANGLES = [-4,-2,0,2,4];
var SCALES = [0.94,0.97,1.0,1.03,1.06];

/* ---------- pull a region out of a source image ---------- */
function crop(src, w, h){
  var c = document.createElement("canvas");
  c.width = w; c.height = h;
  var x = c.getContext("2d");
  x.imageSmoothingQuality = "high";
  var r = src.rect, s = src.scale;
  x.drawImage(src.img, r.x*s, r.y*s, r.w*s, r.h*s, 0, 0, w, h);
  return x.getImageData(0,0,w,h);
}

function gray(id){
  var p = id.data, n = id.width*id.height, g = new Float32Array(n), i, j=0;
  for(i=0;i<p.length;i+=4,j++) g[j] = p[i]*0.299 + p[i+1]*0.587 + p[i+2]*0.114;
  return g;
}

/* ---------- separable box blur ---------- */
function blur(src, w, h, r){
  if(r < 1) return src.slice();
  var tmp = new Float32Array(w*h), out = new Float32Array(w*h);
  var x, y, acc, cnt;
  for(y=0;y<h;y++){
    acc = 0; cnt = 0;
    for(x=-r;x<=r;x++){ if(x>=0 && x<w){ acc += src[y*w+x]; cnt++; } }
    for(x=0;x<w;x++){
      tmp[y*w+x] = acc/cnt;
      var a1 = x+r+1, r1 = x-r;
      if(a1 < w){ acc += src[y*w+a1]; cnt++; }
      if(r1 >= 0){ acc -= src[y*w+r1]; cnt--; }
    }
  }
  for(x=0;x<w;x++){
    acc = 0; cnt = 0;
    for(y=-r;y<=r;y++){ if(y>=0 && y<h){ acc += tmp[y*w+x]; cnt++; } }
    for(y=0;y<h;y++){
      out[y*w+x] = acc/cnt;
      var a2 = y+r+1, r2 = y-r;
      if(a2 < h){ acc += tmp[a2*w+x]; cnt++; }
      if(r2 >= 0){ acc -= tmp[r2*w+x]; cnt--; }
    }
  }
  return out;
}

/* ---------- local contrast normalisation ----------
   Subtracting a heavy blur removes the lighting gradient and most
   specular falloff, which is what makes glare on a glossy proof sleeve
   survivable. It also discards absolute tone, so ink density largely
   drops out and only structural change survives.                      */
function normalize(g, w, h){
  var lo = blur(g, w, h, Math.max(6, Math.round(w/18)));
  var d = new Float32Array(g.length), i;
  for(i=0;i<g.length;i++) d[i] = g[i] - lo[i];
  var mean = 0;
  for(i=0;i<d.length;i++) mean += d[i];
  mean /= d.length;
  var v = 0;
  for(i=0;i<d.length;i++){ var t = d[i]-mean; v += t*t; }
  var sd = Math.sqrt(v/d.length) || 1;
  for(i=0;i<d.length;i++) d[i] = (d[i]-mean)/sd;
  return d;
}

function shrink(g, w, h, f){
  var nw = Math.floor(w/f), nh = Math.floor(h/f);
  var o = new Float32Array(nw*nh), x, y, i, j, acc;
  for(y=0;y<nh;y++) for(x=0;x<nw;x++){
    acc = 0;
    for(j=0;j<f;j++) for(i=0;i<f;i++) acc += g[(y*f+j)*w + (x*f+i)];
    o[y*nw+x] = acc/(f*f);
  }
  return { d:o, w:nw, h:nh };
}

/* ---------- rotate + scale about centre, bilinear ----------
   Two handheld photos differ in both, so the search covers both. */
function warp(src, w, h, deg, sc){
  var out = new Float32Array(w*h);
  var ok = new Uint8Array(w*h);
  if(!deg && sc === 1){
    out.set(src); ok.fill(1);
    return { d:out, ok:ok };
  }
  var rad = deg*Math.PI/180;
  var ca = Math.cos(rad)/sc, sa = Math.sin(rad)/sc;
  var cx = w/2, cy = h/2;
  var x, y, u, v, x0, y0, fx, fy, i;
  for(y=0;y<h;y++) for(x=0;x<w;x++){
    u = ca*(x-cx) + sa*(y-cy) + cx;
    v = -sa*(x-cx) + ca*(y-cy) + cy;
    if(u<0||v<0||u>=w-1||v>=h-1){ out[y*w+x] = 0; continue; }
    x0 = u|0; y0 = v|0; fx = u-x0; fy = v-y0;
    i = y0*w+x0;
    out[y*w+x] = src[i]*(1-fx)*(1-fy) + src[i+1]*fx*(1-fy) +
                 src[i+w]*(1-fx)*fy   + src[i+w+1]*fx*fy;
    ok[y*w+x] = 1;
  }
  return { d:out, ok:ok };
}

function ncc(a, b, w, h, dx, dy){
  var sum = 0, n = 0, x, y, ax, ay;
  for(y=0;y<h;y+=2) for(x=0;x<w;x+=2){
    ax = x+dx; ay = y+dy;
    if(ax<0||ay<0||ax>=w||ay>=h) continue;
    sum += a[y*w+x] * b[ay*w+ax];
    n++;
  }
  return n ? sum/n : -1e9;
}

/* ---------- best rotation + scale + translation ---------- */
function align(a, b, w, h){
  var f = 6;             // coarse factor chosen so the sweep cost stays flat as W grows
  var A = shrink(a,w,h,f);
  var span = Math.round(A.w*0.16);
  var best = {dx:0, dy:0, deg:0, sc:1, s:-1e9};
  var ai, si, dx, dy, s;

  for(ai=0; ai<ANGLES.length; ai++) for(si=0; si<SCALES.length; si++){
    var deg = ANGLES[ai], sc = SCALES[si];
    var Bw = shrink(warp(b, w, h, deg, sc).d, w, h, f);
    for(dy=-span;dy<=span;dy++) for(dx=-span;dx<=span;dx++){
      s = ncc(A.d, Bw.d, A.w, A.h, dx, dy);
      if(s > best.s) best = {dx:dx, dy:dy, deg:deg, sc:sc, s:s};
    }
  }

  /* Refine the angle. A coarse 2-degree step leaves up to 1 degree of
     residual, which at this working width displaces edges by a couple of
     pixels and lights up every character outline as a false difference. */
  var cx = best.dx*f, cy = best.dy*f;
  var fine = {dx:cx, dy:cy, deg:best.deg, sc:best.sc, s:-1e9};
  var step, dg, cand, warped = null;
  for(step=-4; step<=4; step++){
    dg = best.deg + step*0.25;
    cand = warp(b, w, h, dg, best.sc);
    for(dy=cy-f;dy<=cy+f;dy++) for(dx=cx-f;dx<=cx+f;dx++){
      s = ncc(a, cand.d, w, h, dx, dy);
      if(s > fine.s){
        fine = {dx:dx, dy:dy, deg:dg, sc:best.sc, s:s};
        warped = cand;
      }
    }
  }
  fine.warped = warped || warp(b, w, h, fine.deg, fine.sc);
  return fine;
}

/* ---------- connected components ---------- */
function blobs(mask, w, h){
  var seen = new Uint8Array(w*h), out = [], stack = [];
  var x, y, i, px, py, k, q;
  for(y=0;y<h;y++) for(x=0;x<w;x++){
    i = y*w+x;
    if(!mask[i] || seen[i]) continue;
    stack.length = 0; stack.push(i); seen[i] = 1;
    var minx=x, maxx=x, miny=y, maxy=y, area=0;
    while(stack.length){
      k = stack.pop(); area++;
      px = k%w; py = (k-px)/w;
      if(px<minx) minx=px; if(px>maxx) maxx=px;
      if(py<miny) miny=py; if(py>maxy) maxy=py;
      var nb = [k-1, k+1, k-w, k+w];
      for(q=0;q<4;q++){
        var m = nb[q];
        if(m<0 || m>=w*h || seen[m] || !mask[m]) continue;
        if(q===0 && px===0) continue;
        if(q===1 && px===w-1) continue;
        seen[m] = 1; stack.push(m);
      }
    }
    var bw = maxx-minx+1, bh = maxy-miny+1;
    if(area >= MIN_BLOB && Math.min(bw,bh) >= MIN_SIDE){
      out.push({x:minx, y:miny, w:bw, h:bh, area:area});
    }
  }
  return out.sort(function(a,b){ return b.area-a.area; });
}

/* ---------- main entry ----------
   proof / press are each { img, rect, scale }:
     img   - the loaded photo
     rect  - box in display-canvas coordinates
     scale - naturalWidth / displayCanvasWidth for that photo         */
function compare(proof, press, opts){
  opts = opts || {};
  var h = Math.max(64, Math.round(W * (proof.rect.h/proof.rect.w)));

  var pImg = crop(proof, W, h);
  var sImg = crop(press, W, h);

  var pn = normalize(gray(pImg), W, h);
  var sn = normalize(gray(sImg), W, h);

  var fit = align(pn, sn, W, h);
  var sr = fit.warped.d, sok = fit.warped.ok;

  /* Any pixel the warp could not source from inside the press crop is
     excluded, along with a small margin. Comparing real artwork against
     an empty warp corner is the classic border false positive. */
  var m = Math.max(6, Math.round(W*0.02));
  var d = new Float32Array(W*h);
  var live = new Uint8Array(W*h);
  var x, y, i, ax, ay, valid = 0;
  for(y=0;y<h;y++) for(x=0;x<W;x++){
    i = y*W+x;
    ax = x+fit.dx; ay = y+fit.dy;
    if(ax<m||ay<m||ax>=W-m||ay>=h-m) continue;
    if(x<m||y<m||x>=W-m||y>=h-m) continue;
    if(!sok[ay*W+ax]) continue;
    d[i] = Math.abs(pn[i] - sr[ay*W+ax]);
    live[i] = 1;
    valid++;
  }

  var ds = blur(d, W, h, 3);
  var mean = 0, n = 0;
  for(i=0;i<ds.length;i++){ if(live[i]){ mean += ds[i]; n++; } }
  mean /= (n||1);
  var v = 0;
  for(i=0;i<ds.length;i++){ if(live[i]){ var t = ds[i]-mean; v += t*t; } }
  var sd = Math.sqrt(v/(n||1)) || 1;

  var k = opts.sensitivity != null ? opts.sensitivity : 3.2;
  var cut = mean + k*sd;
  var mask = new Uint8Array(W*h), hot = 0;
  for(i=0;i<mask.length;i++){ if(live[i] && ds[i] > cut){ mask[i] = 1; hot++; } }

  /* A box drawn at a very different shape than the other means the two
     regions are not the same crop of the same label. Worth telling the
     operator rather than reporting nonsense differences. */
  var arP = proof.rect.w/proof.rect.h, arS = press.rect.w/press.rect.h;
  var aspectSkew = Math.abs(arP-arS) / Math.max(arP,arS);

  return {
    width: W, height: h,
    proof: pImg, press: sImg,
    fit: fit,
    regions: blobs(mask, W, h),
    diffPct: valid ? (hot/valid)*100 : 0,
    registration: fit.s,
    rotation: fit.deg,
    scaleFit: fit.sc,
    aspectSkew: aspectSkew
  };
}

/* ---------- render the annotated result ---------- */
function render(canvas, result){
  var w = result.width, h = result.height;
  canvas.width = w; canvas.height = h;
  var x = canvas.getContext("2d");
  x.putImageData(result.press, 0, 0);
  x.fillStyle = "rgba(255,255,255,.34)";
  x.fillRect(0,0,w,h);
  x.strokeStyle = "#C41E1E";
  x.lineWidth = 2;
  result.regions.slice(0,40).forEach(function(r){
    x.strokeRect(r.x-3, r.y-3, r.w+6, r.h+6);
  });
  return canvas;
}

return { compare: compare, render: render };
})();
