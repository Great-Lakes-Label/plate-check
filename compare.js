/* ------------------------------------------------------------------
   Plate Check — side-by-side visual comparison
   ------------------------------------------------------------------
   Compares two operator-boxed regions of one photo: the artwork on the
   Art Proof Approval, and the label off the press.

   Copy differences are reliable when the photo is square-on and the
   boxes are drawn to the label edges.

   Colour output is RELATIVE ONLY. Both regions share one frame, one
   light source and one set of camera settings, so a difference between
   them is meaningful as a gross-deviation flag. It is not a delta-E
   measurement, and the proof sheet is not a colour standard.
   ------------------------------------------------------------------ */
window.PlateCompare = (function(){
"use strict";

var W = 512;              // working width for both regions
var BLOCK = 16;           // colour sampling block
var MIN_BLOB = 40;        // ignore difference blobs smaller than this (px area)

/* ---------- pull a region out of the source image ---------- */
function crop(img, rect, srcScale, w, h){
  var c = document.createElement("canvas");
  c.width = w; c.height = h;
  var x = c.getContext("2d");
  x.imageSmoothingQuality = "high";
  x.drawImage(img,
    rect.x*srcScale, rect.y*srcScale, rect.w*srcScale, rect.h*srcScale,
    0, 0, w, h);
  return x.getImageData(0,0,w,h);
}

/* ---------- grayscale ---------- */
function gray(id){
  var p = id.data, n = id.width*id.height, g = new Float32Array(n), i, j=0;
  for(i=0;i<p.length;i+=4,j++) g[j] = p[i]*0.299 + p[i+1]*0.587 + p[i+2]*0.114;
  return g;
}

/* ---------- separable box blur ---------- */
function blur(src, w, h, r){
  if(r < 1) return src.slice();
  var tmp = new Float32Array(w*h), out = new Float32Array(w*h);
  var x,y,i,acc,cnt,d = r*2+1;
  for(y=0;y<h;y++){
    acc = 0; cnt = 0;
    for(x=-r;x<=r;x++){ if(x>=0 && x<w){ acc += src[y*w+x]; cnt++; } }
    for(x=0;x<w;x++){
      tmp[y*w+x] = acc/cnt;
      var add = x+r+1, rem = x-r;
      if(add < w){ acc += src[y*w+add]; cnt++; }
      if(rem >= 0){ acc -= src[y*w+rem]; cnt--; }
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
   Subtracting a heavy blur removes the lighting gradient and most of the
   specular falloff, which is what makes glossy-sleeve glare survivable. */
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

/* ---------- downsample by integer factor ---------- */
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

/* ---------- normalised cross-correlation at an offset ---------- */
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

/* ---------- find the best translation ---------- */
function align(a, b, w, h){
  var f = 4;
  var A = shrink(a,w,h,f), B = shrink(b,w,h,f);
  var span = Math.round(A.w*0.14);
  var best = {dx:0, dy:0, s:-1e9}, dx, dy, s;
  for(dy=-span;dy<=span;dy++) for(dx=-span;dx<=span;dx++){
    s = ncc(A.d, B.d, A.w, A.h, dx, dy);
    if(s > best.s) best = {dx:dx, dy:dy, s:s};
  }
  var cx = best.dx*f, cy = best.dy*f, fine = {dx:cx, dy:cy, s:-1e9};
  for(dy=cy-f;dy<=cy+f;dy++) for(dx=cx-f;dx<=cx+f;dx++){
    s = ncc(a, b, w, h, dx, dy);
    if(s > fine.s) fine = {dx:dx, dy:dy, s:s};
  }
  return fine;
}

/* ---------- connected components on a boolean mask ---------- */
function blobs(mask, w, h){
  var seen = new Uint8Array(w*h), out = [], stack = [];
  var x, y, i, px, py, k;
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
      for(var q=0;q<4;q++){
        var m = nb[q];
        if(m<0 || m>=w*h || seen[m] || !mask[m]) continue;
        if(q===0 && px===0) continue;
        if(q===1 && px===w-1) continue;
        seen[m] = 1; stack.push(m);
      }
    }
    if(area >= MIN_BLOB) out.push({x:minx, y:miny, w:maxx-minx+1, h:maxy-miny+1, area:area});
  }
  return out.sort(function(a,b){ return b.area-a.area; });
}

/* ---------- sRGB -> CIE Lab ---------- */
function toLab(r,g,b){
  function lin(v){ v/=255; return v<=0.04045 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); }
  var R=lin(r), G=lin(g), B=lin(b);
  var X = (R*0.4124+G*0.3576+B*0.1805)/0.95047;
  var Y = (R*0.2126+G*0.7152+B*0.0722);
  var Z = (R*0.0193+G*0.1192+B*0.9505)/1.08883;
  function f(t){ return t>0.008856 ? Math.pow(t,1/3) : (7.787*t)+(16/116); }
  var fx=f(X), fy=f(Y), fz=f(Z);
  return [116*fy-16, 500*(fx-fy), 200*(fy-fz)];
}
function labBlock(id, w, x0, y0, size){
  var p = id.data, r=0,g=0,b=0,n=0, x,y,i;
  for(y=y0;y<y0+size;y++) for(x=x0;x<x0+size;x++){
    i = (y*w+x)*4;
    r+=p[i]; g+=p[i+1]; b+=p[i+2]; n++;
  }
  return n ? toLab(r/n, g/n, b/n) : null;
}

/* ---------- main entry ---------- */
/* proofRect / pressRect are in display-canvas coordinates.
   srcScale converts those to source-image pixels.                     */
function compare(img, proofRect, pressRect, srcScale, opts){
  opts = opts || {};
  var h = Math.max(64, Math.round(W * (proofRect.h/proofRect.w)));

  var pImg = crop(img, proofRect, srcScale, W, h);
  var sImg = crop(img, pressRect, srcScale, W, h);

  var pg = gray(pImg), sg = gray(sImg);
  var pn = normalize(pg, W, h), sn = normalize(sg, W, h);

  var fit = align(pn, sn, W, h);

  /* --- copy difference --- */
  var d = new Float32Array(W*h), x, y, i, ax, ay, valid = 0;
  for(y=0;y<h;y++) for(x=0;x<W;x++){
    i = y*W+x;
    ax = x+fit.dx; ay = y+fit.dy;
    if(ax<0||ay<0||ax>=W||ay>=h){ d[i] = 0; continue; }
    d[i] = Math.abs(pn[i] - sn[ay*W+ax]);
    valid++;
  }
  // small blur suppresses halftone dots and substrate texture
  var ds = blur(d, W, h, 2);
  var mean = 0;
  for(i=0;i<ds.length;i++) mean += ds[i];
  mean /= ds.length;
  var v = 0;
  for(i=0;i<ds.length;i++){ var t = ds[i]-mean; v += t*t; }
  var sd = Math.sqrt(v/ds.length) || 1;

  var k = opts.sensitivity != null ? opts.sensitivity : 3.2;
  var cut = mean + k*sd;
  var mask = new Uint8Array(W*h);
  var hot = 0;
  for(i=0;i<mask.length;i++){ if(ds[i] > cut){ mask[i] = 1; hot++; } }

  var regions = blobs(mask, W, h);
  var diffPct = valid ? (hot/valid)*100 : 0;

  /* --- white-point correction ---
     Even inside one frame the two items sit under slightly different
     illumination (falloff across the lens). Measuring the substrate white
     of each region and subtracting the difference cancels that gradient,
     which is what keeps the colour read from drifting on position alone. */
  function whitePoint(id){
     var acc=[0,0,0], n=0, bx, by;
     for(by=0; by+BLOCK<=h; by+=BLOCK) for(bx=0; bx+BLOCK<=W; bx+=BLOCK){
       var l = labBlock(id, W, bx, by, BLOCK);
       if(l && l[0] >= 88){ acc[0]+=l[0]; acc[1]+=l[1]; acc[2]+=l[2]; n++; }
     }
     return n ? [acc[0]/n, acc[1]/n, acc[2]/n] : null;
  }
  var wpP = whitePoint(pImg), wpS = whitePoint(sImg);
  var wpDelta = (wpP && wpS) ? [wpS[0]-wpP[0], wpS[1]-wpP[1], wpS[2]-wpP[2]] : [0,0,0];

  /* --- relative colour, on blocks that are NOT copy differences --- */
  var colour = [], bx, by, worst = 0;
  for(by=0; by+BLOCK<=h; by+=BLOCK) for(bx=0; bx+BLOCK<=W; bx+=BLOCK){
    // skip blocks touching a difference region or the unaligned border
    var skip = false, xx, yy;
    for(yy=by; yy<by+BLOCK && !skip; yy++)
      for(xx=bx; xx<bx+BLOCK; xx++) if(mask[yy*W+xx]){ skip = true; break; }
    if(skip) continue;
    var sx = bx+fit.dx, sy = by+fit.dy;
    if(sx<0||sy<0||sx+BLOCK>W||sy+BLOCK>h) continue;

    var la = labBlock(pImg, W, bx, by, BLOCK);
    var lb = labBlock(sImg, W, sx, sy, BLOCK);
    if(!la || !lb) continue;
    // near-white and near-black blocks carry no useful ink signal
    if(la[0] > 92 || la[0] < 8) continue;
    var dl = (lb[0]-wpDelta[0])-la[0],
        da = (lb[1]-wpDelta[1])-la[1],
        db = (lb[2]-wpDelta[2])-la[2];
    var dist = Math.sqrt(dl*dl + da*da + db*db);
    if(dist > worst) worst = dist;
    colour.push({x:bx, y:by, d:dist, dl:dl, da:da, db:db});
  }
  colour.sort(function(a,b){ return b.d-a.d; });

  return {
    width: W, height: h,
    proof: pImg, press: sImg,
    fit: fit,
    regions: regions,
    diffPct: diffPct,
    colour: colour,
    colourWorst: worst,
    whitePointDelta: Math.sqrt(wpDelta[0]*wpDelta[0]+wpDelta[1]*wpDelta[1]+wpDelta[2]*wpDelta[2]),
    registration: fit.s      // low value = alignment probably failed
  };
}

/* ---------- render the annotated result ---------- */
function render(canvas, result, showColour){
  var w = result.width, h = result.height;
  canvas.width = w; canvas.height = h;
  var x = canvas.getContext("2d");
  x.putImageData(result.press, 0, 0);

  // dim, then highlight
  x.fillStyle = "rgba(255,255,255,.34)";
  x.fillRect(0,0,w,h);

  if(showColour){
    result.colour.slice(0,40).forEach(function(b){
      if(b.d < 6) return;
      var a = Math.min(.5, (b.d-6)/28);
      x.fillStyle = "rgba(224,162,46," + a.toFixed(3) + ")";
      x.fillRect(b.x, b.y, BLOCK, BLOCK);
    });
  }

  x.strokeStyle = "#C41E1E";
  x.lineWidth = 2;
  result.regions.slice(0,40).forEach(function(r){
    var pad = 3;
    x.strokeRect(r.x-pad, r.y-pad, r.w+pad*2, r.h+pad*2);
  });
  return canvas;
}

return { compare: compare, render: render, BLOCK: BLOCK };
})();
