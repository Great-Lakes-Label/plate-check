/* ------------------------------------------------------------------
   Plate Check — OCR front end
   ------------------------------------------------------------------
   Everything here exists because of measurements taken against real
   GLL proof sheets and press samples. The notes matter; without these
   steps the reader returns almost nothing usable on this artwork.

   1. ORIENTATION. iPad photos carry an EXIF orientation tag. Decoded
      without it, the pixels are rotated and OCR returns mirrored
      nonsense ("APPROVAL" comes back as "TWAOUddV"). Browsers usually
      correct this, but not dependably, so the raw pixels are requested
      explicitly and the rotation is applied here.

   2. COLOUR CHANNELS. Reversed type — white on the blue and light-blue
      bands — has almost no luminance contrast, so greyscale OCR cannot
      see it. Blue ink is dark in the RED channel, which is what makes
      the artwork code and nutrition figures readable. Measured on real
      photos: greyscale alone reached 35% coverage with 3 findings (2
      false); grey+red+blue reached 63% with 1 finding (0 false). A
      fourth channel added nothing, so three passes is the recipe.

   3. POSITION GROUPING. Each pass reads the same physical word slightly
      differently. Grouping by position and keeping EVERY reading as a
      candidate is what stops "737g" misread once as "73%" from being
      reported as a copy difference.
   ------------------------------------------------------------------ */
window.PlateOCR = (function(){
"use strict";

var CHANNELS = ["gray","red","blue"];
var TARGET_W = 2400;      // working width per OCR pass
var MIN_CONF = 60;

var worker = null, workerLang = null;

/* ---------- EXIF orientation ---------- */
function exifOrientation(buf){
  var v = new DataView(buf);
  if(v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return 1;   // not a JPEG
  var off = 2;
  while(off + 4 < v.byteLength){
    var marker = v.getUint16(off);
    if(marker === 0xFFE1){                                       // APP1 / Exif
      var base = off + 10;
      if(v.getUint32(off+4) !== 0x45786966) return 1;
      var little = v.getUint16(base) === 0x4949;
      var ifd = base + v.getUint32(base + 4, little);
      var n = v.getUint16(ifd, little);
      for(var i=0;i<n;i++){
        var e = ifd + 2 + i*12;
        if(v.getUint16(e, little) === 0x0112) return v.getUint16(e+8, little);
      }
      return 1;
    }
    if((marker & 0xFF00) !== 0xFF00) break;
    off += 2 + v.getUint16(off+2);
  }
  return 1;
}

function applyOrientation(bmpOrImg, o){
  var w = bmpOrImg.width || bmpOrImg.naturalWidth;
  var h = bmpOrImg.height || bmpOrImg.naturalHeight;
  var swap = (o >= 5 && o <= 8);
  var c = document.createElement("canvas");
  c.width  = swap ? h : w;
  c.height = swap ? w : h;
  var x = c.getContext("2d");
  switch(o){
    case 2: x.transform(-1, 0, 0, 1, w, 0); break;
    case 3: x.transform(-1, 0, 0,-1, w, h); break;
    case 4: x.transform( 1, 0, 0,-1, 0, h); break;
    case 5: x.transform( 0, 1, 1, 0, 0, 0); break;
    case 6: x.transform( 0, 1,-1, 0, h, 0); break;
    case 7: x.transform( 0,-1,-1, 0, h, w); break;
    case 8: x.transform( 0,-1, 1, 0, 0, w); break;
    default: break;
  }
  x.drawImage(bmpOrImg, 0, 0);
  return c;
}

/* Load a picked file into an upright canvas. */
function loadPhoto(file){
  return file.arrayBuffer().then(function(buf){
    var o = exifOrientation(buf);
    var blob = new Blob([buf], {type: file.type || "image/jpeg"});

    // ask for raw pixels so the rotation is ours alone to apply
    if(typeof createImageBitmap === "function"){
      return createImageBitmap(blob, {imageOrientation:"none"})
        .then(function(bmp){ return applyOrientation(bmp, o); })
        .catch(function(){ return viaImg(blob, o); });
    }
    return viaImg(blob, o);
  });
}
function viaImg(blob, o){
  return new Promise(function(res, rej){
    var url = URL.createObjectURL(blob);
    var im = new Image();
    im.onload = function(){
      // the element path may already be oriented; only rotate if the
      // decoded shape still matches the unrotated tag
      var swap = (o >= 5 && o <= 8);
      var looksRotated = swap && im.naturalHeight > im.naturalWidth;
      res(applyOrientation(im, looksRotated ? 1 : o));
      URL.revokeObjectURL(url);
    };
    im.onerror = function(){ URL.revokeObjectURL(url); rej(new Error("image decode failed")); };
    im.src = url;
  });
}

/* ---------- build one channel image for OCR ---------- */
function channelCanvas(src, rect, channel, targetW){
  var sx, sy, sw, sh;
  if(rect){ sx=rect.x; sy=rect.y; sw=rect.w; sh=rect.h; }
  else { sx=0; sy=0; sw=src.width; sh=src.height; }

  var scale = Math.min(4, Math.max(1, targetW / sw));
  var c = document.createElement("canvas");
  c.width  = Math.round(sw*scale);
  c.height = Math.round(sh*scale);
  var x = c.getContext("2d");
  x.imageSmoothingQuality = "high";
  x.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);

  var d = x.getImageData(0,0,c.width,c.height), p = d.data, i, v, lo=255, hi=0;
  for(i=0;i<p.length;i+=4){
    if(channel === "red")        v = p[i];
    else if(channel === "green") v = p[i+1];
    else if(channel === "blue")  v = p[i+2];
    else                         v = (p[i]*0.299 + p[i+1]*0.587 + p[i+2]*0.114)|0;
    p[i] = p[i+1] = p[i+2] = v;
    if(v<lo) lo=v; if(v>hi) hi=v;
  }
  var span = Math.max(1, hi-lo);
  for(i=0;i<p.length;i+=4){
    v = ((p[i]-lo)*255/span)|0;
    p[i] = p[i+1] = p[i+2] = v<0?0:(v>255?255:v);
  }
  x.putImageData(d,0,0);
  return { canvas:c, scale:scale, ox:sx, oy:sy };
}

/* ---------- worker, created once and reused ---------- */
function getWorker(paths){
  if(worker && workerLang === "eng") return Promise.resolve(worker);
  return Tesseract.createWorker("eng", 1, {
    workerPath: paths.workerPath, corePath: paths.corePath, langPath: paths.langPath
  }).then(function(w){ worker = w; workerLang = "eng"; return w; });
}

/* ---------- read a region across all channels ---------- */
function read(src, rect, paths, onProgress, channels){
  var raw = [];
  var chans = channels || CHANNELS;
  return getWorker(paths).then(function(w){
    var chain = Promise.resolve();
    chans.forEach(function(ch, idx){
      chain = chain.then(function(){
        if(onProgress) onProgress(idx / chans.length, ch);
        var prep = channelCanvas(src, rect, ch, TARGET_W);
        return w.recognize(prep.canvas).then(function(res){
          var ws = (res.data && res.data.words) || [];
          ws.forEach(function(word){
            var c = (word.confidence == null) ? 100 : word.confidence;
            var t = String(word.text || "").trim();
            if(!t || c < MIN_CONF) return;
            var b = word.bbox || {x0:0,y0:0,x1:0,y1:0};
            raw.push({
              text: t, conf: c,
              x: prep.ox + b.x0/prep.scale,
              y: prep.oy + b.y0/prep.scale,
              w: (b.x1-b.x0)/prep.scale,
              h: (b.y1-b.y0)/prep.scale
            });
          });
        });
      });
    });
    return chain;
  }).then(function(){
    if(onProgress) onProgress(1, "done");
    return groupAndOrder(raw, rect ? rect.h : src.height);
  });
}

/* ---------- one entry per physical word, carrying every reading ---------- */
function groupAndOrder(raw, regionH){
  raw.sort(function(a,b){ return b.conf - a.conf; });
  var groups = [], i, j, t, g, cx, cy, hit;
  for(i=0;i<raw.length;i++){
    t = raw[i];
    cx = t.x + t.w/2; cy = t.y + t.h/2;
    hit = null;
    for(j=0;j<groups.length;j++){
      g = groups[j];
      if(Math.abs(cx-g.cx) < Math.max(t.w,g.w)*0.6 &&
         Math.abs(cy-g.cy) < Math.max(t.h,g.h)*0.6){ hit = g; break; }
    }
    if(hit){
      if(hit.alts.indexOf(t.text) === -1) hit.alts.push(t.text);
    } else {
      groups.push({ cx:cx, cy:cy, x:t.x, y:t.y, w:t.w, h:t.h,
                    text:t.text, confidence:t.conf, alts:[t.text] });
    }
  }
  /* Reading order: band rows by a fixed share of the region height. Using
     each word's own height breaks when a label mixes 40pt titles with 6pt
     legal type, which scrambles the sequence the diff depends on. */
  var band = Math.max(1, regionH * 0.025);
  groups.sort(function(a,b){
    var ra = Math.round(a.cy/band), rb = Math.round(b.cy/band);
    return ra === rb ? a.x - b.x : ra - rb;
  });
  return groups;
}

/* ---------- locate the artwork for an item number on a proof sheet ----------
   The number that identifies a piece of artwork is printed directly below
   it. The same number also appears in the approval form lower down, next
   to the words "Product Number", so those occurrences are skipped. */
function findArtwork(words, itemDigits, src){
  function digits(s){ return String(s||"").replace(/\D/g,""); }

  var captions = [], i, j;
  for(i=0;i<words.length;i++){
    var w = words[i];
    var isItem = w.alts.some(function(a){ return digits(a) === itemDigits; });
    if(!isItem) continue;
    // form field? look for a label immediately to its left on the same line
    var formField = false;
    for(j=0;j<words.length;j++){
      var q = words[j];
      if(q === w) continue;
      if(Math.abs((q.y+q.h/2)-(w.y+w.h/2)) > w.h*0.9) continue;
      if(q.x >= w.x || (w.x - q.x) > w.h*18) continue;
      if(/^(PRODUCT|NUMBER)/i.test(q.text)) { formField = true; break; }
    }
    if(!formField) captions.push(w);
  }
  if(!captions.length) return null;

  // all item-number captions on the sheet, so neighbours can bound the region
  var allCaps = words.filter(function(w){
    return w.alts.some(function(a){ return /^\d{2}-?\d{7}$/.test(String(a).replace(/[^\d-]/g,"")); });
  });

  // the caption with the most words above it is the one under real artwork
  captions.sort(function(a,b){
    function above(c){ return words.filter(function(w){ return w.cy < c.y - c.h*0.4; }).length; }
    return above(b) - above(a);
  });
  var cap = captions[0];
  var capCx = cap.x + cap.w/2;

  // horizontal bound: halfway to the nearest other caption on the same line
  var half = src.width;
  allCaps.forEach(function(o){
    if(o === cap) return;
    if(Math.abs((o.y+o.h/2)-(cap.y+cap.h/2)) > cap.h*2.5) return;
    var d = Math.abs((o.x+o.w/2) - capCx);
    if(d/2 < half) half = d/2;
  });
  if(half > src.width*0.5) half = src.width*0.5;

  /* A generous fixed reach above the caption. Bounding by the gap between
     READ words fails here: the light-blue band's reversed type is often
     unreadable, so the largest gap sits in the middle of the artwork and
     the region gets clipped to the bottom stripe. Over-reaching is the
     safer error — stray dimension callouts are absorbed downstream by the
     run-length guard in copycheck. */
  var left = Math.max(0, capCx - half);
  var top = Math.max(0, cap.y - src.height*0.40);

  return {
    x: left,
    y: top,
    w: Math.min(src.width - left, half*2),
    h: Math.max(40, (cap.y - cap.h*0.35) - top),
    caption: cap
  };
}

function terminate(){
  if(worker){ try { worker.terminate(); } catch(e){} worker = null; workerLang = null; }
}

return {
  loadPhoto: loadPhoto,
  read: read,
  findArtwork: findArtwork,
  terminate: terminate,
  CHANNELS: CHANNELS
};
})();
